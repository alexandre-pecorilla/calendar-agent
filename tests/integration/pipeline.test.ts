import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CalcomCache } from '../../src/calcom/cache.js';
import { CalcomClient } from '../../src/calcom/client.js';
import { loadConfig } from '../../src/config/env.js';
import { parseMasterKey } from '../../src/crypto/envelope.js';
import { Secret } from '../../src/crypto/secret.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { DeepSeekClient } from '../../src/llm/deepseek.js';
import { createLogger } from '../../src/logging/logger.js';
import { AnswerPipeline } from '../../src/pipeline/answer.js';
import { Writable } from 'node:stream';

/**
 * The pipeline end to end with a mock Cal.com server (recording every path) and
 * a scripted DeepSeek (served by the same mock on /chat/completions). The
 * model's behaviour is tested live in tests/live; here the contract around it
 * is tested: intent routing, fixed replies, date validation, error mapping,
 * logging, and the verification fallback.
 */
const NY = 'America/New_York';
const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString('base64');
const NOW = DateTime.fromISO('2026-10-09T12:00', { zone: NY });

let server: Server;
let base: string;
const hits: string[] = [];
let scriptedParse: unknown = null;
let scriptedPhrase: string | null = null;
let deepseekMode: 'ok' | 'empty' | 'down' | 'garbage' = 'ok';
let calcomMode: 'ok' | 'down' = 'ok';

const SCHEDULE = { status: 'success', data: { id: 1, ownerId: 1, name: 'W', timeZone: NY, availability: [{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '09:00', endTime: '18:00' }], isDefault: true, overrides: [] } };
const CALENDARS = { status: 'success', data: { connectedCalendars: [{ integration: { slug: 'google-calendar' }, credentialId: 1, calendars: [{ externalId: 'a@x.com', readOnly: false, isSelected: true, credentialId: 1 }, { externalId: 'off@x.com', readOnly: false, isSelected: false, credentialId: 1 }] }], destinationCalendar: { id: 1, integration: 'g', externalId: 'a@x.com', primaryEmail: null, userId: 1, eventTypeId: null, credentialId: 1 } } };
const busyNY = (a: string, b: string) => ({ start: DateTime.fromISO(a, { zone: NY }).toUTC().toISO(), end: DateTime.fromISO(b, { zone: NY }).toUTC().toISO(), source: 'x' });
let busyData: unknown[] = [];
const BUSY_DEFAULT = [busyNY('2026-10-12T17:30', '2026-10-12T18:00'), busyNY('2026-10-13T09:00', '2026-10-13T12:00')];

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  hits.push(`${req.method} ${url.pathname}`);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code: number, payload: unknown, raw = false) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(raw ? String(payload) : JSON.stringify(payload));
    };
    if (url.pathname === '/chat/completions') {
      if (deepseekMode === 'down') return send(503, { error: 'down' });
      if (deepseekMode === 'garbage') return send(200, { choices: [{ message: { content: 'not json at all' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      if (deepseekMode === 'empty') return send(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      const parsed = JSON.parse(body) as { response_format?: unknown };
      const content = parsed.response_format ? JSON.stringify(scriptedParse) : (scriptedPhrase ?? '');
      return send(200, { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 50, completion_tokens_details: { reasoning_tokens: 10 } } });
    }
    if (calcomMode === 'down') return send(500, { status: 'error' });
    if (url.pathname === '/v2/schedules/default') return send(200, SCHEDULE);
    if (url.pathname === '/v2/calendars') return send(200, CALENDARS);
    if (url.pathname === '/v2/calendars/busy-times') return send(200, { status: 'success', data: busyData });
    return send(404, { status: 'error' });
  });
}

let repos: Repositories;
let pipeline: AnswerPipeline;
const logLines: string[] = [];

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = loadConfig({ OWNER_NAME: 'Alex', OWNER_ALIASES: 'Alexandre', INSTALL_MODE: 'single', SLACK_APP_TOKEN: 'xapp-1', SLACK_SIGNING_SECRET: 'signing-secret', SLACK_BOT_TOKEN: 'xoxb-1', ADMIN_PASSWORD: 'correct-horse-battery', MASTER_KEY: KEY_B64, DATA_DIR: ':memory:' });
  repos = createRepositories(':memory:', parseMasterKey(KEY_B64));
  const sink = new Writable({ write(c, _e, cb) { logLines.push(String(c)); cb(); } });
  const log = createLogger('info', sink);
  const calcom = new CalcomClient({ apiKey: () => new Secret('cal_live_x'), baseUrl: base, retries: 0, sleep: async () => {} });
  const deepseek = new DeepSeekClient({ apiKey: () => new Secret('sk-x'), baseUrl: base });
  pipeline = new AnswerPipeline({ config, settings: repos.settings, queries: repos.queries, calcom, calcomCache: new CalcomCache(calcom), deepseek, log });
});
afterAll(() => {
  server.close();
  repos.db.close();
});
beforeEach(() => {
  hits.length = 0;
  deepseekMode = 'ok';
  calcomMode = 'ok';
  scriptedPhrase = null;
  busyData = BUSY_DEFAULT;
  repos.db.exec('DELETE FROM queries');
});

const ctx = (over: Partial<Parameters<AnswerPipeline['ask']>[0]> = {}) => ({ userId: 'U1', userName: 'Bob', workspaceId: 'T1', workspaceName: 'Acme', entryPoint: 'dm' as const, askerTz: NY, askerLocale: 'en-US', now: NOW, ...over });
const parse = (over: Record<string, unknown>) => ({ intent: 'point', language: 'en', timezone_override: null, point_time: null, range_start: null, range_end: null, excluded_weekdays: [], part_of_day: null, duration_minutes: null, ...over });

describe('AnswerPipeline', () => {
  it('answers a point question from the draft when the phrasing drifts, and logs the query', async () => {
    scriptedParse = parse({ point_time: '2026-10-12T16:00' });
    scriptedPhrase = 'Alex is free at 3:00 PM today!';
    const r = await pipeline.ask(ctx(), '<@U9> is Alex free Monday at 4pm?');
    expect(r.text).toBe('Yes, Alex is free Monday Oct 12 from 4:00 PM to 5:30 PM, New York time.');
    expect(r.debug.phrased).toBe(false);
    expect(r.debug.verification).toContain('unknown_time');
    expect(r.debug.busyCount).toBe(2);
    expect(hits.filter((h) => h.startsWith('GET'))).toEqual(['GET /v2/schedules/default', 'GET /v2/calendars', 'GET /v2/calendars/busy-times']);
    const row = repos.queries.get(r.queryId)!;
    expect(row.question).toBe('is Alex free Monday at 4pm?');
    busyData = [busyNY('2026-10-12T15:00', '2026-10-12T16:30')];
    const busy = await pipeline.ask(ctx(), 'Monday 4pm?');
    expect(busy.text).toBe('No, Alex is busy Monday Oct 12 at 4:00 PM. Next free window: 4:30 PM to 6:00 PM, New York time.');
    expect(row.intent).toBe('point');
    expect(row.answer).toBe(r.text);
    expect(row.cost_usd).toBeGreaterThan(0);
    expect(row.timezone_used).toBe(NY);
    expect(logLines.join('')).not.toContain('is Alex free');
  });

  it('accepts a faithful phrasing', async () => {
    scriptedParse = parse({ point_time: '2026-10-12T16:00' });
    scriptedPhrase = 'Good news: Alex is free Monday Oct 12 from 4:00 PM to 5:30 PM, New York time.';
    const r = await pipeline.ask(ctx(), 'Monday 4pm?');
    expect(r.text).toBe(scriptedPhrase);
    expect(r.debug.phrased).toBe(true);
  });

  it('routes fixed intents without touching Cal.com busy times', async () => {
    for (const [intent, needle] of [['other_person', "other people's"], ['self', 'not yours'], ['booking', "can't book"], ['off_topic', 'free or busy'], ['help', 'Ask me']] as const) {
      scriptedParse = parse({ intent });
      const r = await pipeline.ask(ctx(), 'x');
      expect(r.text).toContain(needle);
      expect(r.intent).toBe(intent);
    }
    expect(hits.some((h) => h.includes('busy-times'))).toBe(false);
  });

  it('answers in French with the asker locale when the model says "other", and honours a zone override', async () => {
    scriptedParse = parse({ intent: 'day', language: 'other', range_start: '2026-10-13', range_end: '2026-10-13', timezone_override: 'Europe/Paris' });
    const r = await pipeline.ask(ctx({ askerLocale: 'fr-FR' }), 'mardi ?');
    expect(r.language).toBe('fr');
    expect(r.debug.zoneSource).toBe('override');
    expect(r.text).toContain('heure de Paris');
    expect(r.text).toContain("Disponibilités d'Alex mardi 13 octobre");
    expect(r.text).toContain('18h00 à 0h00');
  });

  it('validates dates: past, beyond horizon, inverted, missing', async () => {
    scriptedParse = parse({ intent: 'range', range_start: '2026-09-01', range_end: '2026-09-05' });
    expect((await pipeline.ask(ctx(), 'x')).text).toContain('already in the past');
    scriptedParse = parse({ intent: 'day', range_start: '2027-01-10', range_end: '2027-01-10' });
    expect((await pipeline.ask(ctx(), 'x')).text).toContain('4 weeks ahead');
    scriptedParse = parse({ intent: 'range', range_start: '2026-10-20', range_end: '2026-10-15' });
    expect((await pipeline.ask(ctx(), 'x')).text).toContain("didn't understand");
    scriptedParse = parse({ intent: 'point', point_time: null });
    expect((await pipeline.ask(ctx(), 'x')).text).toContain("didn't understand");
    scriptedParse = parse({ intent: 'range', range_start: '2026-10-05', range_end: '2026-12-31' });
    const r = await pipeline.ask(ctx(), 'x');
    expect(r.intent).toBe('range');
    expect(r.debug.windows.length).toBeGreaterThan(0);
  });

  it('maps provider failures to the cannot-check reply with an error code', async () => {
    deepseekMode = 'down';
    let r = await pipeline.ask(ctx(), 'x');
    expect(r.text).toContain("can't check");
    expect(r.debug.error).toBe('deepseek:unavailable');
    deepseekMode = 'empty';
    r = await pipeline.ask(ctx(), 'x');
    expect(r.debug.error).toBe('deepseek:empty');
    deepseekMode = 'garbage';
    r = await pipeline.ask(ctx(), 'x');
    expect(r.intent).toBe('clarify:invalid_json');
    deepseekMode = 'ok';
    calcomMode = 'down';
    scriptedParse = parse({ point_time: '2026-10-12T16:00' });
    r = await pipeline.ask(ctx(), 'x');
    expect(r.debug.error).toBe('calcom:unavailable');
    expect(repos.queries.get(r.queryId)!.error).toBe('calcom:unavailable');
  });

  it('enforces the per-user limit for Slack entry points but not for the sandbox', async () => {
    scriptedParse = parse({ intent: 'help' });
    repos.settings.set('rate_user_per_minute', '2');
    const limited = ctx({ userId: 'U-limit' });
    await pipeline.ask(limited, 'x');
    await pipeline.ask(limited, 'x');
    const third = await pipeline.ask(limited, 'x');
    expect(third.intent).toBe('rate_limited');
    const sandbox = await pipeline.ask(ctx({ userId: 'U-limit', entryPoint: 'sandbox' }), 'x');
    expect(sandbox.intent).toBe('help');
    repos.settings.set('daily_budget', '1');
    expect((await pipeline.ask(ctx({ userId: 'U-other' }), 'x')).intent).toBe('over_capacity');
    repos.settings.delete('daily_budget');
    repos.settings.delete('rate_user_per_minute');
  });

  it('R1-5: the kind follows the dates, not the model label', async () => {
    scriptedParse = parse({ intent: 'day', range_start: '2026-10-12', range_end: '2026-10-14' });
    const r = await pipeline.ask(ctx(), 'x');
    expect(r.text).toContain('from Mon Oct 12 to Wed Oct 14');
    expect(r.debug.draft!.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(3);
  });

  it('R1-6: an unusable zone name is a clarification; an abbreviation maps to a canonical zone', async () => {
    scriptedParse = parse({ point_time: '2026-10-12T09:00', timezone_override: 'Paris' });
    const bad = await pipeline.ask(ctx(), 'x');
    expect(bad.intent).toBe('point:clarify_zone');
    expect(bad.text).toContain("didn't understand");
    scriptedParse = parse({ point_time: '2026-10-12T16:00', timezone_override: 'EST' });
    const est = await pipeline.ask(ctx({ askerTz: 'Europe/Paris' }), 'x');
    expect(est.debug.zone).toBe('America/New_York');
    expect(est.debug.zoneSource).toBe('override');
    expect(est.text).toContain('New York time');
  });

  it('R1-7: an unrecognised weekday in the exclusions is a clarification', async () => {
    scriptedParse = { ...parse({ intent: 'range', range_start: '2026-10-12', range_end: '2026-10-16' }), excluded_weekdays: ['monday', 'Weds'] };
    const r = await pipeline.ask(ctx(), 'x');
    expect(r.intent).toBe('range:clarify_weekday');
  });

  it('R1-11: questions refused by a limit do not count toward the limits', async () => {
    scriptedParse = parse({ intent: 'help' });
    repos.settings.set('rate_user_per_minute', '2');
    const u = ctx({ userId: 'U-count' });
    await pipeline.ask(u, 'x');
    await pipeline.ask(u, 'x');
    expect((await pipeline.ask(u, 'x')).intent).toBe('rate_limited');
    await pipeline.ask(u, 'x');
    expect(repos.queries.countUserSince('U-count', '2000-01-01T00:00:00.000Z')).toBe(2);
    expect(repos.queries.list({ userId: 'U-count' }).total).toBe(4);
    repos.settings.delete('rate_user_per_minute');
  });

  it('over 100 varied questions, only allowlisted GET paths are ever requested', async () => {
    const intents = ['point', 'day', 'range', 'open', 'other_person', 'self', 'booking', 'off_topic', 'help'];
    for (let i = 0; i < 100; i++) {
      const intent = intents[i % intents.length]!;
      scriptedParse = parse({ intent, point_time: intent === 'point' ? '2026-10-12T16:00' : null, range_start: intent === 'day' || intent === 'range' ? '2026-10-12' : null, range_end: intent === 'day' ? '2026-10-12' : intent === 'range' ? '2026-10-16' : null });
      await pipeline.ask(ctx({ userId: `U${i}`, entryPoint: 'sandbox' }), `question ${i}`);
    }
    const calcomHits = hits.filter((h) => !h.endsWith('/chat/completions'));
    expect(calcomHits.every((h) => h.startsWith('GET '))).toBe(true);
    const paths = new Set(calcomHits.map((h) => h.split(' ')[1]));
    expect([...paths].every((p) => ['/v2/schedules/default', '/v2/calendars', '/v2/calendars/busy-times'].includes(p!))).toBe(true);
    expect(paths.has('/v2/calendars/busy-times')).toBe(true);
  });

  it('returns the help text for an empty question without calling any provider', async () => {
    const r = await pipeline.ask(ctx(), '<@U9>   ');
    expect(r.intent).toBe('help');
    expect(hits).toEqual([]);
  });
});
