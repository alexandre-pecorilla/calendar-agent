/**
 * Verification of the phrased reply against the deterministic draft (scope
 * §6.4, tightened after review R1-2). The reply is accepted only if:
 * - every time it mentions (AM/PM, French `16h30` or `16 h 30`, 24-hour `15:00`,
 *   midnight/noon words) normalises to a time the draft used, and the ordered
 *   sequence of those times equals the draft's sequence exactly;
 * - every date it mentions is one the draft used, and every date of the draft
 *   is present;
 * - its bullet lines are exactly the draft's bullet lines, in order;
 * - the yes/no verdict of a point answer is not inverted;
 * - every required phrase (zone label, qualifiers) is present;
 * - it is under the length cap and contains no link.
 * Otherwise the draft itself is sent.
 */
export const REPLY_MAX_CHARS = 1500;

const EN_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FR_DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const EN_DATE = new RegExp(`\\b(${EN_DAYS.join('|')})[a-z]*,?\\s+(${EN_MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})\\b`, 'gi');
const FR_DATE = new RegExp(`\\b(${FR_DAYS.join('|')})\\s+(\\d{1,2})(?:er)?\\s+(${FR_MONTHS.join('|')})\\b`, 'gi');

const AMPM = /\b(\d{1,2})(?:[:.](\d{2}))?\s?(am|pm)\b/gi;
const FR_H = /\b(\d{1,2})\s?h\s?(\d{2})?\b(?!\s?(?:am|pm))/gi;
const H24 = /\b(\d{1,2}):(\d{2})\b(?!\s?(?:am|pm))/gi;
const WORDS: Array<[RegExp, (lang: 'en' | 'fr') => string]> = [
  [/\bmidnight\b/gi, () => '12:00 AM'],
  [/\bnoon\b/gi, () => '12:00 PM'],
  [/\bminuit\b/gi, () => '0h00'],
  [/\bmidi\b/gi, () => '12h00'],
];

/** Canonical key of a date token: `mon|oct|12` or `lundi|octobre|12`. */
export function dateKey(token: string): string | null {
  const en = new RegExp(EN_DATE.source, 'i').exec(token);
  if (en) return `${en[1]!.slice(0, 3).toLowerCase()}|${en[2]!.slice(0, 3).toLowerCase()}|${Number(en[3])}`;
  const fr = new RegExp(FR_DATE.source, 'i').exec(token);
  if (fr) return `${fr[1]!.toLowerCase()}|${fr[3]!.toLowerCase()}|${Number(fr[2])}`;
  return null;
}

/** Every time mention in reading order, normalised to the renderer's own formats. */
export function extractTimeTokens(text: string, lang: 'en' | 'fr' = 'en'): string[] {
  const found: Array<{ index: number; token: string }> = [];
  for (const m of text.matchAll(AMPM)) found.push({ index: m.index, token: `${Number(m[1])}:${m[2] ?? '00'} ${m[3]!.toUpperCase()}` });
  for (const m of text.matchAll(FR_H)) found.push({ index: m.index, token: `${Number(m[1])}h${m[2] ?? '00'}` });
  for (const m of text.matchAll(H24)) found.push({ index: m.index, token: `${m[1]}:${m[2]}` });
  for (const [re, key] of WORDS) for (const m of text.matchAll(re)) found.push({ index: m.index, token: key(lang) });
  return found.sort((a, b) => a.index - b.index).map((f) => f.token);
}

export function extractDateKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EN_DATE)) out.push(dateKey(m[0])!);
  for (const m of text.matchAll(FR_DATE)) out.push(dateKey(m[0])!);
  return out;
}

export interface Draft {
  text: string;
  lines: string[];
  tokens: string[];
  timeSequence?: string[];
  dateTokens?: string[];
  required?: string[];
  polarity?: 'yes' | 'no' | null;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

const YES_WORDS = /\b(is free|is available|est disponible|est libre|^yes\b|^oui\b)/i;
const NO_WORDS = /\b(is busy|is not available|isn't available|not free|n'est pas disponible|pas disponible|est occupé|^no\b|^non\b)/i;

export function verifyReply(reply: string, draft: Draft, lang: 'en' | 'fr' = 'en'): VerifyResult {
  const text = reply.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > REPLY_MAX_CHARS) return { ok: false, reason: 'too_long' };
  // No links of any spelling, no Slack markup (`<!channel>`, `<@U…>`, `<url|text>`): the draft never has them (R4-4).
  if (/https?:\/\/|www\.|mailto:|\b[a-z0-9-]+\.(com|net|org|io|fr|ca|co|app|ai|dev|me|info|xyz)\b/i.test(text)) return { ok: false, reason: 'link' };
  if (/[<>]/.test(text)) return { ok: false, reason: 'markup' };

  // Times: allowed set and exact ordered sequence. Duration qualifiers such as
  // "1 h" or "1 hour" are not times: they are blanked out before scanning.
  const allowed = new Set(draft.tokens);
  let scan = text;
  for (const phrase of draft.required ?? []) {
    if (/^\d+\s?(h|hour|hours|min)(\s\d+)?$/.test(phrase)) scan = scan.replace(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ');
  }
  const replyTimes = extractTimeTokens(scan, lang);
  for (const tok of replyTimes) if (!allowed.has(tok)) return { ok: false, reason: `unknown_time:${tok}` };
  const draftTimes = draft.timeSequence ?? extractTimeTokens(draft.text, lang);
  if (replyTimes.length !== draftTimes.length || replyTimes.some((t, i) => t !== draftTimes[i])) {
    return { ok: false, reason: 'time_sequence' };
  }

  // Dates: only the draft's, and all of the draft's.
  const allowedDates = new Set((draft.dateTokens ?? draft.tokens).map(dateKey).filter((k): k is string => k !== null));
  const replyDates = extractDateKeys(text);
  for (const k of replyDates) if (!allowedDates.has(k)) return { ok: false, reason: `unknown_date:${k}` };
  for (const k of allowedDates) if (!replyDates.includes(k)) return { ok: false, reason: `missing_date:${k}` };

  // Bullet lines: exactly the draft's, in order.
  const draftBullets = draft.lines.filter((l) => l.startsWith('•'));
  const replyBullets = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('•'));
  if (draftBullets.length !== replyBullets.length || draftBullets.some((l, i) => l !== replyBullets[i])) {
    return { ok: false, reason: 'bullet_lines' };
  }

  // Polarity of a yes/no answer.
  if (draft.polarity === 'yes' && (NO_WORDS.test(text) || !YES_WORDS.test(text))) return { ok: false, reason: 'polarity' };
  if (draft.polarity === 'no' && (YES_WORDS.test(text.replace(/next (free )?window[^.]*/gi, '')) || !NO_WORDS.test(text))) return { ok: false, reason: 'polarity' };

  const lower = text.toLowerCase();
  for (const phrase of draft.required ?? []) {
    if (!lower.includes(phrase.toLowerCase())) return { ok: false, reason: `missing_required:${phrase}` };
  }
  return { ok: true };
}
