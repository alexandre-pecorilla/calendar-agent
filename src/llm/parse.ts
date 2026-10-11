import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { DeepSeekClient, Usage } from './deepseek.js';

export const INTENTS = ['point', 'day', 'range', 'open', 'other_person', 'self', 'booking', 'help', 'off_topic'] as const;
export type Intent = (typeof INTENTS)[number];
const WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
/** "2026-10-12T16:00:00" or "…T16:00Z" → "2026-10-12T16:00" (local time; an explicit offset is ignored, the zone comes from the question or the asker). */
const localMinute = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v.trim()) ? v.trim().slice(0, 16) : v);

/**
 * Field-level normalisation before validation (R1-7): weekday names and the
 * part of day are lower-cased, a point time keeps its first sixteen characters.
 * An unrecognised weekday makes the whole list invalid (→ clarification)
 * rather than silently widening the question.
 */
export const parsedQuestionSchema = z.object({
  intent: z.enum(INTENTS),
  language: z.preprocess(lower, z.enum(['en', 'fr', 'other'])).catch('other'),
  timezone_override: z.string().trim().min(1).nullable().catch(null),
  point_time: z.preprocess(localMinute, z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)).nullable().catch(null),
  range_start: date.nullable().catch(null),
  range_end: date.nullable().catch(null),
  excluded_weekdays: z.preprocess((v) => (Array.isArray(v) ? v.map(lower) : v), z.array(z.enum(WEEKDAY_NAMES))).nullable().catch(null),
  part_of_day: z.preprocess(lower, z.enum(['morning', 'afternoon', 'evening'])).nullable().catch(null),
  duration_minutes: z.number().int().min(5).max(720).nullable().catch(null),
});
export type ParsedQuestion = z.infer<typeof parsedQuestionSchema>;

/** luxon weekday numbers, Monday = 1. */
export function weekdayNumber(name: (typeof WEEKDAY_NAMES)[number]): number {
  return WEEKDAY_NAMES.indexOf(name) + 1;
}

export interface ParseContext {
  ownerName: string;
  aliases: readonly string[];
  now: DateTime;
  askerTz: string;
  ownerTz: string;
}

export const PARSE_PROMPT_PATH = new URL('./prompts/parse.md', import.meta.url);
let template: string | null = null;
export function parsePromptTemplate(): string {
  if (!template) template = readFileSync(PARSE_PROMPT_PATH, 'utf8');
  return template;
}

export function buildParsePrompt(ctx: ParseContext): string {
  const now = ctx.now.setZone(ctx.askerTz);
  const aliases = ctx.aliases.length ? ` People also call the owner ${ctx.aliases.map((a) => `"${a}"`).join(', ')}.` : '';
  return parsePromptTemplate()
    .replaceAll('{{OWNER_NAME}}', ctx.ownerName)
    .replaceAll('{{ALIASES_SENTENCE}}', aliases)
    .replaceAll('{{NOW}}', now.toFormat("yyyy-MM-dd'T'HH:mm"))
    .replaceAll('{{NOW_WEEKDAY}}', now.setLocale('en-US').toFormat('cccc'))
    .replaceAll('{{TODAY}}', now.toISODate()!)
    .replaceAll('{{ASKER_TZ}}', ctx.askerTz)
    .replaceAll('{{OWNER_TZ}}', ctx.ownerTz);
}

export type ParseOutcome =
  | { ok: true; parsed: ParsedQuestion; usage: Usage; latencyMs: number; raw: string }
  | { ok: false; reason: 'invalid_json' | 'invalid_shape'; usage: Usage; latencyMs: number; raw: string };

/** Call 1: the only call that ever sees the asker's text. Output is schema-validated; anything else is a clarification. */
export async function parseQuestion(client: DeepSeekClient, ctx: ParseContext, question: string): Promise<ParseOutcome> {
  const res = await client.complete({
    system: buildParsePrompt(ctx),
    user: `Question: """${question}"""`,
    json: true,
    maxTokens: 1500,
    effort: 'low',
  });
  let obj: unknown;
  try {
    obj = JSON.parse(res.content);
  } catch {
    return { ok: false, reason: 'invalid_json', usage: res.usage, latencyMs: res.latencyMs, raw: res.content };
  }
  const parsed = parsedQuestionSchema.safeParse(obj);
  if (!parsed.success) return { ok: false, reason: 'invalid_shape', usage: res.usage, latencyMs: res.latencyMs, raw: res.content };
  return { ok: true, parsed: parsed.data, usage: res.usage, latencyMs: res.latencyMs, raw: res.content };
}
