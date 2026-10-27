import { IANAZone } from 'luxon';
import { countryOfZone } from './zone-countries.js';

export type Lang = 'en' | 'fr';

export function isValidZone(tz: string | null | undefined): tz is string {
  return typeof tz === 'string' && tz.length > 0 && IANAZone.isValidZone(tz);
}

/** Abbreviations people type, mapped to a canonical zone before validation (R1-6). */
const ABBREVIATIONS: Record<string, string> = {
  EST: 'America/New_York', EDT: 'America/New_York', ET: 'America/New_York',
  CST: 'America/Chicago', CDT: 'America/Chicago', CT: 'America/Chicago',
  MST: 'America/Denver', MDT: 'America/Denver', MT: 'America/Denver',
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PT: 'America/Los_Angeles',
  CET: 'Europe/Paris', CEST: 'Europe/Paris', GMT: 'Europe/London', BST: 'Europe/London',
  IST: 'Asia/Kolkata', JST: 'Asia/Tokyo', AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
  UTC: 'UTC', Z: 'UTC',
};

/**
 * A timezone named in a question is usable only as `UTC` or a canonical
 * `Area/City` zone (or a known abbreviation mapped to one). Legacy names such
 * as `EST` as a zone (fixed offset, no DST) or `US/Eastern` are not accepted
 * as-is, and an unusable override must become a clarification, never a
 * silent fallback to another zone.
 */
export function normalizeZoneOverride(raw: string | null | undefined): { zone: string } | { invalid: true } | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim();
  if (!v) return null;
  const abbr = ABBREVIATIONS[v.toUpperCase()];
  if (abbr) return { zone: abbr };
  if (/^(Etc|US|SystemV|Canada|Brazil|Mexico|Chile)\//i.test(v)) return { invalid: true };
  if (!v.includes('/') || !isValidZone(v)) return { invalid: true };
  return { zone: v };
}

/** French cities with an aspirated h: no elision. */
const FR_H_ASPIRE = new Set(['Hong Kong', 'Havana', 'Ho Chi Minh', 'Harare', 'Hanoi', 'Hovd']);
/** City names that differ in French. */
const FR_CITY: Record<string, string> = {
  London: 'Londres', Brussels: 'Bruxelles', Lisbon: 'Lisbonne', Vienna: 'Vienne', Warsaw: 'Varsovie', Copenhagen: 'Copenhague',
  Moscow: 'Moscou', Athens: 'Athènes', Singapore: 'Singapour', Cairo: 'Le Caire', Algiers: 'Alger', Montreal: 'Montréal',
  Jerusalem: 'Jérusalem', Dubai: 'Dubaï', Geneva: 'Genève', 'Mexico City': 'Mexico', 'Sao Paulo': 'São Paulo', Beirut: 'Beyrouth',
  Bucharest: 'Bucarest', Edinburgh: 'Édimbourg',
};

/** "America/New_York" → "New York"; "UTC" → "UTC"; "Etc/GMT+2" → "UTC-2" (POSIX sign inverted). */
export function zoneCity(tz: string): string {
  if (tz.toUpperCase() === 'UTC' || tz === 'Etc/UTC' || tz === 'Etc/GMT') return 'UTC';
  const gmt = /^Etc\/GMT([+-])(\d{1,2})$/.exec(tz);
  if (gmt) return `UTC${gmt[1] === '+' ? '-' : '+'}${gmt[2]}`;
  const last = tz.split('/').pop() ?? tz;
  return last.replace(/_/g, ' ');
}

const FR_VOWEL = /^[aeiouyàâäéèêëîïôöùûüh]/i;

/** The mandatory label on every answer (scope §6). */
export function zoneLabel(tz: string, lang: Lang): string {
  const city = zoneCity(tz);
  if (city.startsWith('UTC')) return city;
  if (lang === 'fr') {
    const name = FR_CITY[city] ?? city;
    const elide = FR_VOWEL.test(name) && !FR_H_ASPIRE.has(city);
    return elide ? `heure d'${name}` : `heure de ${name}`;
  }
  return `${city} time`;
}

export type ZoneSource = 'override' | 'asker' | 'owner';

/** A usable override named in the question wins, then the asker's Slack zone, then the owner's schedule zone. */
export function resolveZone(args: {
  override?: string | null | undefined;
  askerTz?: string | null | undefined;
  ownerTz: string;
}): { zone: string; source: ZoneSource } {
  const o = normalizeZoneOverride(args.override);
  if (o && 'zone' in o) return { zone: o.zone, source: 'override' };
  if (isValidZone(args.askerTz)) return { zone: args.askerTz, source: 'asker' };
  return { zone: args.ownerTz, source: 'owner' };
}

export type ClockStyle = '12h' | '24h';

/** Flag of the zone's country as regional-indicator letters; a globe for UTC and for a zone the table does not know. */
export function zoneFlag(tz: string): string {
  if (zoneCity(tz).startsWith('UTC')) return '🌐';
  const cc = countryOfZone(tz);
  if (cc) return String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
  return /^America\//.test(tz) ? '🌎' : /^(Asia|Australia|Pacific|Indian)\//.test(tz) ? '🌏' : '🌍';
}

const CLOCKS = new Map<string, ClockStyle>();

/** The clock the zone's country prefers, as CLDR records it (via Intl): "12h" (AM/PM) or "24h". UTC and unknown zones: 24-hour. */
export function clockStyle(tz: string): ClockStyle {
  const cc = countryOfZone(tz);
  if (!cc || zoneCity(tz).startsWith('UTC')) return '24h';
  let style = CLOCKS.get(cc);
  if (!style) {
    const cycle = new Intl.DateTimeFormat(`en-${cc}`, { hour: 'numeric' }).resolvedOptions().hourCycle;
    style = cycle === 'h11' || cycle === 'h12' ? '12h' : '24h';
    CLOCKS.set(cc, style);
  }
  return style;
}
