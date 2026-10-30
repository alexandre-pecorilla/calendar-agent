import type { DateTime } from 'luxon';
import type { ClockStyle, Lang } from './timezone.js';

/** EN "4:00 PM" (12-hour clock) or "16:00" (24-hour clock), FR always "16h00". */
export function formatTime(t: DateTime, lang: Lang, clock: ClockStyle = '12h'): string {
  if (lang === 'fr') return t.toFormat("H'h'mm");
  if (clock === '24h') return t.toFormat('HH:mm');
  return t.setLocale('en-US').toFormat('h:mm a');
}

/** EN "Mon Oct 13", FR "lundi 13 octobre" ("lundi 1er octobre" on the first). */
export function formatDate(t: DateTime, lang: Lang): string {
  if (lang === 'fr') return t.setLocale('fr-FR').toFormat(t.day === 1 ? "cccc d'er' LLLL" : 'cccc d LLLL');
  return t.setLocale('en-US').toFormat('ccc LLL d');
}

/** EN "Monday Oct 13", FR "lundi 13 octobre". */
export function formatDateLong(t: DateTime, lang: Lang): string {
  if (lang === 'fr') return formatDate(t, lang);
  return t.setLocale('en-US').toFormat('cccc LLL d');
}

/** EN "Monday", FR "lundi". */
export function formatWeekday(t: DateTime, lang: Lang): string {
  return t.setLocale(lang === 'fr' ? 'fr-FR' : 'en-US').toFormat('cccc');
}

export function formatRange(a: DateTime, b: DateTime, lang: Lang, clock: ClockStyle = '12h'): string {
  return lang === 'fr' ? `${formatTime(a, lang, clock)} à ${formatTime(b, lang, clock)}` : `${formatTime(a, lang, clock)} to ${formatTime(b, lang, clock)}`;
}

/**
 * The compact form of a listing (1.2.0): EN "7:00–10:00 AM" when both ends
 * share AM or PM, "10:30 AM–7:00 PM" otherwise, "13:00–16:00" on a 24-hour
 * clock, FR "13h00–16h00". Listings are never rephrased by the model, so this
 * form never meets the verifier.
 */
export function formatSpan(a: DateTime, b: DateTime, lang: Lang, clock: ClockStyle = '12h'): string {
  if (lang === 'fr' || clock === '24h') return `${formatTime(a, lang, clock)}–${formatTime(b, lang, clock)}`;
  const ta = a.setLocale('en-US');
  const tb = b.setLocale('en-US');
  const head = ta.toFormat('a') === tb.toFormat('a') ? ta.toFormat('h:mm') : ta.toFormat('h:mm a');
  return `${head}–${tb.toFormat('h:mm a')}`;
}

export function formatDuration(min: number, lang: Lang): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (lang === 'fr') {
    if (h && m) return `${h} h ${m}`;
    if (h) return `${h} h`;
    return `${m} min`;
  }
  if (h && m) return `${h} h ${m} min`;
  if (h) return h === 1 ? '1 hour' : `${h} hours`;
  return `${m} min`;
}
