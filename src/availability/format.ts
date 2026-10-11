import type { DateTime } from 'luxon';
import type { Lang } from './timezone.js';

/** EN "4:00 PM", FR "16h00". */
export function formatTime(t: DateTime, lang: Lang): string {
  if (lang === 'fr') return t.toFormat("H'h'mm");
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

export function formatRange(a: DateTime, b: DateTime, lang: Lang): string {
  return lang === 'fr' ? `${formatTime(a, lang)} à ${formatTime(b, lang)}` : `${formatTime(a, lang)} to ${formatTime(b, lang)}`;
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
