import { Info, type DateTime } from 'luxon';
import { englishPossessive, frenchDe } from '../config/identity.js';
import type { AvailabilityRequest, AvailabilityResult } from './engine.js';
import { formatDate, formatDateLong, formatDuration, formatTime } from './format.js';
import type { Lang } from './timezone.js';

/**
 * Deterministic rendering of an availability result in the asker's language,
 * with the timezone label always present. This text is both the fallback
 * reply and the source of truth the LLM phrasing is verified against: every
 * time and date token the model may use is collected in `tokens`.
 */
export interface RenderContext {
  ownerName: string;
  lang: Lang;
  zoneLabel: string;
}

export interface Rendered {
  text: string;
  lines: string[];
  /** Every time and date token used; the phrased reply may use no other. */
  tokens: string[];
  /** The time tokens in the order the draft states them; the phrased reply must keep that exact sequence. */
  timeSequence: string[];
  /** The date tokens the draft states; each must appear in the phrased reply. */
  dateTokens: string[];
  /** Phrases the reply must keep: the zone label and every qualifier (duration, exclusions, part of day). */
  required: string[];
  /** For yes/no answers: the verdict the phrasing must not invert. */
  polarity: 'yes' | 'no' | null;
}

class Collector {
  readonly tokens = new Set<string>();
  readonly timeSequence: string[] = [];
  readonly dateTokens = new Set<string>();
  constructor(
    private readonly lang: Lang,
    private readonly zone: string,
  ) {}
  time(t0: DateTime): string {
    const t = t0.setZone(this.zone);
    const s = formatTime(t, this.lang);
    this.tokens.add(s);
    this.timeSequence.push(s);
    return s;
  }
  range(a: DateTime, b: DateTime): string {
    // Format in the display zone, exactly like the tokens (R1-10).
    return `${this.time(a)}${this.lang === 'fr' ? ' à ' : ' to '}${this.time(b)}`;
  }
  date(t0: DateTime): string {
    const t = t0.setZone(this.zone);
    const s = formatDate(t, this.lang);
    this.tokens.add(s);
    this.dateTokens.add(s);
    return s;
  }
  dateLong(t0: DateTime): string {
    const t = t0.setZone(this.zone);
    const s = formatDateLong(t, this.lang);
    this.tokens.add(s);
    this.dateTokens.add(s);
    return s;
  }
  rendered(text: string, lines: string[], required: string[], polarity: 'yes' | 'no' | null): Rendered {
    return { text, lines, tokens: [...this.tokens], timeSequence: [...this.timeSequence], dateTokens: [...this.dateTokens], required, polarity };
  }
}

function weekdayName(n: number, lang: Lang): string {
  return Info.weekdays('long', { locale: lang === 'fr' ? 'fr-FR' : 'en-US' })[n - 1] ?? '';
}

function describeScope(req: AvailabilityRequest, res: AvailabilityResult, c: Collector, lang: Lang, required: string[]): string {
  let desc: string;
  if (req.kind === 'day') {
    desc = c.dateLong(res.rangeStart);
  } else if (req.kind === 'open') {
    const n = res.days.length || 5;
    desc = lang === 'fr' ? `sur les ${n} prochains jours ouvrés` : `over the next ${n} working days`;
  } else {
    const last = res.rangeEnd.minus({ days: 1 });
    desc = lang === 'fr' ? `du ${c.dateLong(res.rangeStart)} au ${c.dateLong(last)}` : `from ${c.date(res.rangeStart)} to ${c.date(last)}`;
  }
  if (req.partOfDay) {
    const p = req.partOfDay;
    const phrase = lang === 'fr' ? (p === 'morning' ? 'le matin' : p === 'afternoon' ? "l'après-midi" : 'le soir') : `in the ${p}`;
    required.push(phrase);
    desc += ` ${phrase}`;
  }
  if (req.excludedWeekdays?.length) {
    const names = req.excludedWeekdays.map((n) => weekdayName(n, lang));
    required.push(...names);
    const joined = names.join(lang === 'fr' ? ' et ' : ' and ');
    desc += lang === 'fr' ? ` (sauf ${joined})` : ` (except ${joined})`;
  }
  return desc;
}

export function renderResult(res: AvailabilityResult, req: AvailabilityRequest, ctx: RenderContext): Rendered {
  const { lang, ownerName, zoneLabel } = ctx;
  const c = new Collector(lang, req.zone);
  const lines: string[] = [];
  // The zone label and the owner's name must survive the phrasing (R4-4).
  const required: string[] = [zoneLabel, ownerName];

  if (res.kind === 'point' && res.verdict) {
    const p = req.point!.setZone(req.zone);
    const v = res.verdict;
    const dur = req.durationMin ? formatDuration(req.durationMin, lang) : null;
    if (dur && (v.kind === 'free' || v.kind === 'free_short' || v.kind === 'busy')) required.push(dur);
    let text: string;
    let polarity: 'yes' | 'no' | null = null;
    if (v.kind === 'past') {
      required.length = 0;
      text = lang === 'fr' ? 'Ce moment est déjà passé.' : 'That time is already in the past.';
    } else if (v.kind === 'no_hours') {
      required.length = 0;
      text =
        lang === 'fr'
          ? `${ownerName} ne prend pas de rendez-vous le ${c.dateLong(p)}.`
          : `${ownerName} does not take meetings on ${c.dateLong(p)}.`;
    } else if (v.kind === 'outside_hours') {
      text =
        lang === 'fr'
          ? `${c.dateLong(p)} à ${c.time(p)} est en dehors des heures habituelles ${frenchDe(ownerName)}, ${zoneLabel}.`
          : `${c.dateLong(p)} at ${c.time(p)} is outside ${englishPossessive(ownerName)} usual hours, ${zoneLabel}.`;
    } else if (v.kind === 'free') {
      polarity = 'yes';
      const tail = dur ? (lang === 'fr' ? ` (au moins ${dur})` : ` (at least ${dur})`) : '';
      text =
        lang === 'fr'
          ? `Oui, ${ownerName} est disponible ${c.dateLong(p)} de ${c.time(v.window.start)} à ${c.time(v.window.end)}${tail}, ${zoneLabel}.`
          : `Yes, ${ownerName} is free ${c.dateLong(p)} from ${c.time(v.window.start)} to ${c.time(v.window.end)}${tail}, ${zoneLabel}.`;
    } else if (v.kind === 'free_short') {
      const head =
        lang === 'fr'
          ? `${ownerName} est disponible ${c.dateLong(p)} à ${c.time(v.window.start)} mais seulement jusqu'à ${c.time(v.window.end)}, ${zoneLabel}.`
          : `${ownerName} is free ${c.dateLong(p)} at ${c.time(v.window.start)} but only until ${c.time(v.window.end)}, ${zoneLabel}.`;
      const tail = v.next
        ? lang === 'fr'
          ? ` Prochain créneau d'au moins ${dur} : ${c.range(v.next.start, v.next.end)}.`
          : ` Next window of at least ${dur}: ${c.range(v.next.start, v.next.end)}.`
        : lang === 'fr'
          ? ` Aucun autre créneau d'au moins ${dur} ce jour-là.`
          : ` No later window of at least ${dur} that day.`;
      text = head + tail;
    } else {
      polarity = 'no';
      const head =
        lang === 'fr'
          ? `Non, ${ownerName} n'est pas disponible ${c.dateLong(p)} à ${c.time(p)}.`
          : `No, ${ownerName} is busy ${c.dateLong(p)} at ${c.time(p)}.`;
      const what = dur ? (lang === 'fr' ? `Prochain créneau d'au moins ${dur}` : `Next window of at least ${dur}`) : lang === 'fr' ? 'Prochain créneau' : 'Next free window';
      const tail = v.next
        ? ` ${what}${lang === 'fr' ? ' : ' : ': '}${c.range(v.next.start, v.next.end)}, ${zoneLabel}.`
        : lang === 'fr'
          ? ` Aucune autre disponibilité${dur ? ` d'au moins ${dur}` : ''} ce jour-là, ${zoneLabel}.`
          : ` No other availability${dur ? ` of at least ${dur}` : ''} that day, ${zoneLabel}.`;
      text = head + tail;
    }
    lines.push(text);
    return c.rendered(text, lines, required, polarity);
  }

  const scope = describeScope(req, res, c, lang, required);
  let duration = '';
  if (req.durationMin) {
    const d = formatDuration(req.durationMin, lang);
    required.push(d);
    duration = lang === 'fr' ? `, créneaux d'au moins ${d}` : `, windows of at least ${d}`;
  }
  const anyAvailability = res.days.some((d) => d.windows.length > 0);
  if (!anyAvailability) {
    const text =
      lang === 'fr'
        ? `${ownerName} n'a aucune disponibilité ${scope}${duration}, ${zoneLabel}.`
        : `${ownerName} has no availability ${scope}${duration}, ${zoneLabel}.`;
    lines.push(text);
    return c.rendered(text, lines, required, null);
  }
  const header =
    lang === 'fr'
      ? `Disponibilités ${frenchDe(ownerName)} ${scope}${duration}, ${zoneLabel} :`
      : `${englishPossessive(ownerName)} availability ${scope}${duration}, ${zoneLabel}:`;
  lines.push(header);
  if (res.kind === 'day') {
    // A day result carries exactly one day (the kind is derived from the dates, R1-5).
    const d = res.days[0]!;
    if (d.wholeDay) {
      const w = d.windows[0]!;
      lines.push(lang === 'fr' ? `• toute la journée, ${c.range(w.start, w.end)}` : `• all day, ${c.range(w.start, w.end)}`);
    } else {
      for (const w of d.windows) lines.push(`• ${c.range(w.start, w.end)}`);
    }
    return c.rendered(lines.join('\n'), lines, required, null);
  }
  for (const d of res.days) {
    const label = c.date(d.day);
    if (d.windows.length === 0) {
      lines.push(lang === 'fr' ? `• ${label} : aucune disponibilité` : `• ${label}: no availability`);
      continue;
    }
    if (d.wholeDay) {
      const w = d.windows[0]!;
      lines.push(lang === 'fr' ? `• ${label} : toute la journée, ${c.range(w.start, w.end)}` : `• ${label}: all day, ${c.range(w.start, w.end)}`);
      continue;
    }
    const parts = d.windows.map((w) => c.range(w.start, w.end)).join(', ');
    lines.push(lang === 'fr' ? `• ${label} : ${parts}` : `• ${label}: ${parts}`);
  }
  if (res.truncated) {
    lines.push(
      lang === 'fr'
        ? `(premiers jours affichés ; demandez une semaine précise pour la suite)`
        : `(first days shown; ask for a specific week for the rest)`,
    );
  }
  return c.rendered(lines.join('\n'), lines, required, null);
}
