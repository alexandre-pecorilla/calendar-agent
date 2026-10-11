import { DateTime } from 'luxon';
import { computeAvailability, type AvailabilityRequest } from '../availability/engine.js';
import { formatRange } from '../availability/format.js';
import { renderResult } from '../availability/render.js';
import { isValidZone, normalizeZoneOverride, resolveZone, zoneLabel, type Lang, type ZoneSource } from '../availability/timezone.js';
import type { CalcomCache } from '../calcom/cache.js';
import { CalcomError, type CalcomClient } from '../calcom/client.js';
import type { AppConfig } from '../config/env.js';
import type { EntryPoint, QueriesRepository } from '../db/repos/queries.js';
import type { SettingsRepository } from '../db/repos/settings.js';
import { DeepSeekError, type DeepSeekClient, type Usage } from '../llm/deepseek.js';
import { parseQuestion, weekdayNumber, type ParsedQuestion } from '../llm/parse.js';
import { phraseReply } from '../llm/phrase.js';
import type { Logger } from '../logging/logger.js';
import { sanitizeQuestion } from '../security/input.js';
import { checkLimits } from './rate-limit.js';
import { fixedReply, type FixedKind } from './fixed-replies.js';

export interface AskContext {
  userId: string;
  userName?: string | null | undefined;
  workspaceId?: string | null | undefined;
  workspaceName?: string | null | undefined;
  entryPoint: EntryPoint;
  channelId?: string | null | undefined;
  askerTz?: string | null | undefined;
  askerLocale?: string | null | undefined;
  /** Injected "now" (sandbox, CLI, tests). */
  now?: DateTime | undefined;
}

export interface AskDebug {
  question: string;
  truncated: boolean;
  parsed: ParsedQuestion | null;
  parseRaw: string | null;
  zone: string;
  zoneSource: ZoneSource;
  zoneLabel: string;
  language: Lang;
  busyCount: number | null;
  windows: string[];
  draft: string | null;
  phrased: boolean;
  verification: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUsd: number;
  error: string | null;
}

export interface AskResult {
  text: string;
  intent: string;
  language: Lang;
  queryId: number;
  debug: AskDebug;
}

export interface PipelineDeps {
  config: AppConfig;
  settings: SettingsRepository;
  queries: QueriesRepository;
  calcom: CalcomClient;
  calcomCache: CalcomCache;
  deepseek: DeepSeekClient;
  log: Logger;
}

const COUNTED: ReadonlySet<EntryPoint> = new Set(['dm', 'mention', 'slash']);

function langFromLocale(locale: string | null | undefined): Lang | null {
  if (!locale) return null;
  if (/^fr\b/i.test(locale)) return 'fr';
  if (/^en\b/i.test(locale)) return 'en';
  return null;
}

/**
 * The single entry point every surface calls (Slack handlers, sandbox, CLI).
 * Order: sanitize → limits → schedule → parse (call 1) → fixed intents →
 * validate dates → availability → render → phrase (call 2) → verify → log.
 */
export class AnswerPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async ask(ctx: AskContext, rawText: string): Promise<AskResult> {
    const { config, settings, queries, log } = this.deps;
    const started = Date.now();
    const now = (ctx.now ?? DateTime.now()).toUTC();
    const sanitized = sanitizeQuestion(rawText);
    const usage: Usage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, reasoningTokens: 0, costUsd: 0 };
    const addUsage = (u: Usage | null) => {
      if (!u) return;
      usage.promptTokens += u.promptTokens;
      usage.completionTokens += u.completionTokens;
      usage.cacheHitTokens += u.cacheHitTokens;
      usage.reasoningTokens += u.reasoningTokens;
      usage.costUsd += u.costUsd;
    };
    let language: Lang = langFromLocale(ctx.askerLocale) ?? 'en';
    let zone = isValidZone(ctx.askerTz) ? ctx.askerTz : 'UTC';
    let zoneSource: ZoneSource = isValidZone(ctx.askerTz) ? 'asker' : 'owner';
    const debug: AskDebug = {
      question: sanitized.text,
      truncated: sanitized.truncated,
      parsed: null,
      parseRaw: null,
      zone,
      zoneSource,
      zoneLabel: zoneLabel(zone, language),
      language,
      busyCount: null,
      windows: [],
      draft: null,
      phrased: false,
      verification: 'n/a',
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      error: null,
    };
    const horizonDays = settings.getNumber('horizon_days');
    const fixed = (kind: FixedKind, lang: Lang = language) =>
      fixedReply(kind, lang, { ownerName: config.ownerName, botName: config.botName, horizonWeeks: Math.max(1, Math.round(horizonDays / 7)) });

    let intent = 'unknown';
    let text: string;
    let errorCode: string | null = null;
    let limitVerdict: ReturnType<typeof checkLimits> = null;
    try {
      if (sanitized.empty) {
        intent = 'help';
        text = fixed('help');
      } else if ((limitVerdict = COUNTED.has(ctx.entryPoint) ? checkLimits(queries, settings, { userId: ctx.userId, workspaceId: ctx.workspaceId ?? null, now }) : null)) {
        intent = limitVerdict;
        text = fixed(limitVerdict);
      } else {
        const schedule = await this.deps.calcomCache.defaultSchedule();
        if (!schedule) throw new CalcomError('bad_response', 'The owner has no default schedule in Cal.com.');
        const ownerTz = schedule.timeZone;
        const askerTz = isValidZone(ctx.askerTz) ? ctx.askerTz : ownerTz;

        const parsed = await parseQuestion(this.deps.deepseek, { ownerName: config.ownerName, aliases: config.ownerAliases, now, askerTz, ownerTz }, sanitized.text);
        addUsage(parsed.usage);
        debug.parseRaw = parsed.raw;
        if (!parsed.ok) {
          intent = `clarify:${parsed.reason}`;
          text = fixed('clarify');
        } else {
          const p = parsed.parsed;
          debug.parsed = p;
          intent = p.intent;
          if (p.language === 'en' || p.language === 'fr') language = p.language;
          const resolved = resolveZone({ override: p.timezone_override, askerTz: ctx.askerTz, ownerTz });
          zone = resolved.zone;
          zoneSource = resolved.source;
          debug.zone = zone;
          debug.zoneSource = zoneSource;
          debug.language = language;
          debug.zoneLabel = zoneLabel(zone, language);

          const override = normalizeZoneOverride(p.timezone_override);
          if (p.intent === 'other_person' || p.intent === 'self' || p.intent === 'booking' || p.intent === 'off_topic' || p.intent === 'help') {
            text = fixed(p.intent);
          } else if (override && 'invalid' in override) {
            // The model interpreted the time in a zone we cannot use: ask rather than guess (R1-6).
            intent = `${p.intent}:clarify_zone`;
            text = fixed('clarify');
          } else if (p.excluded_weekdays === null) {
            intent = `${p.intent}:clarify_weekday`;
            text = fixed('clarify');
          } else {
            const req = this.buildRequest(p, zone, language, now, horizonDays);
            if ('fixed' in req) {
              intent = `${p.intent}:${req.fixed}`;
              text = fixed(req.fixed);
            } else {
              const selected = await this.deps.calcomCache.selectedCalendars();
              const calendars = selected.map((c) => ({ credentialId: c.credentialId, externalId: c.externalId }));
              const result = await computeAvailability(
                {
                  schedule,
                  fetchBusy: (dateFrom, dateTo, timeZone) => this.deps.calcom.busyTimes({ dateFrom, dateTo, timeZone, calendars }),
                  settings: { noiseFloorMin: settings.getNumber('noise_floor_minutes'), listingCapDays: settings.getNumber('listing_cap_days'), openDays: 5 },
                },
                req,
              );
              debug.busyCount = result.busyCount;
              debug.windows = result.days.flatMap((d) => d.windows.map((w) => `${d.day.toISODate()} ${formatRange(w.start, w.end, 'en')}`));
              const draft = renderResult(result, req, { ownerName: config.ownerName, lang: language, zoneLabel: zoneLabel(zone, language) });
              debug.draft = draft.text;
              const phrased = await phraseReply(this.deps.deepseek, { ownerName: config.ownerName, lang: language, draft });
              addUsage(phrased.usage);
              debug.phrased = phrased.phrased;
              debug.verification = phrased.verification;
              text = phrased.text;
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof CalcomError) errorCode = `calcom:${err.kind}`;
      else if (err instanceof DeepSeekError) errorCode = `deepseek:${err.kind}`;
      else errorCode = `internal:${(err as Error).name}`;
      log.warn({ errorCode, entryPoint: ctx.entryPoint }, 'question failed');
      text = fixed('cannot_check');
    }

    debug.latencyMs = Date.now() - started;
    debug.promptTokens = usage.promptTokens;
    debug.completionTokens = usage.completionTokens;
    debug.reasoningTokens = usage.reasoningTokens;
    debug.costUsd = Number(usage.costUsd.toFixed(6));
    debug.error = errorCode;
    debug.language = language;
    const queryId = queries.insert({
      received_at: now.toISO()!,
      workspace_id: ctx.workspaceId ?? null,
      workspace_name: ctx.workspaceName ?? null,
      user_id: ctx.userId,
      user_name: ctx.userName ?? null,
      entry_point: ctx.entryPoint,
      channel_id: ctx.channelId ?? null,
      question: sanitized.text,
      intent,
      parsed_json: debug.parsed ? JSON.stringify(debug.parsed) : null,
      answer: text,
      language,
      timezone_used: zone,
      latency_ms: debug.latencyMs,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      cost_usd: debug.costUsd,
      error: errorCode,
    });
    log.info({ queryId, intent, entryPoint: ctx.entryPoint, latencyMs: debug.latencyMs, costUsd: debug.costUsd, errorCode }, 'question answered');
    return { text, intent, language, queryId, debug };
  }

  private buildRequest(p: ParsedQuestion, zone: string, lang: Lang, now: DateTime, horizonDays: number): AvailabilityRequest | { fixed: FixedKind } {
    const today = now.setZone(zone).startOf('day');
    const horizonEnd = today.plus({ days: horizonDays + 1 });
    const excludedWeekdays = (p.excluded_weekdays ?? []).map(weekdayNumber);
    if (p.intent === 'point') {
      if (!p.point_time) return { fixed: 'clarify' };
      const point = DateTime.fromISO(p.point_time, { zone });
      if (!point.isValid) return { fixed: 'clarify' };
      if (point >= horizonEnd) return { fixed: 'beyond_horizon' };
      return { kind: 'point', zone, lang, now, point, durationMin: p.duration_minutes };
    }
    if (p.intent === 'open') {
      return { kind: 'open', zone, lang, now, durationMin: p.duration_minutes, partOfDay: p.part_of_day };
    }
    const startIso = p.range_start ?? p.range_end;
    const endIso = p.range_end ?? p.range_start;
    if (!startIso || !endIso) return { fixed: 'clarify' };
    let start = DateTime.fromISO(startIso, { zone }).startOf('day');
    let endExclusive = DateTime.fromISO(endIso, { zone }).startOf('day').plus({ days: 1 });
    if (!start.isValid || !endExclusive.isValid || endExclusive <= start) return { fixed: 'clarify' };
    if (endExclusive <= today) return { fixed: 'past' };
    if (start >= horizonEnd) return { fixed: 'beyond_horizon' };
    if (start < today) start = today;
    if (endExclusive > horizonEnd) endExclusive = horizonEnd;
    // The kind follows the dates, never the model's label (R1-5).
    const kind = endExclusive.diff(start, 'days').days <= 1 ? 'day' : 'range';
    return { kind, zone, lang, now, rangeStart: start, rangeEnd: endExclusive, excludedWeekdays, partOfDay: p.part_of_day, durationMin: p.duration_minutes };
  }
}
