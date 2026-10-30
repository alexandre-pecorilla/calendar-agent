import { Info, type DateTime } from 'luxon';
import { englishPossessive, frenchDe } from '../config/identity.js';
import type { AvailabilityRequest, AvailabilityResult, SlotResult } from './engine.js';
import { formatDate, formatDateLong, formatDuration, formatSpan, formatTime } from './format.js';
import type { Interval } from './intervals.js';
import { clockStyle, zoneFlag, type ClockStyle, type Lang } from './timezone.js';
import type { SlotVerdict } from './windows.js';

/**
 * Deterministic rendering of an availability result in the asker's language,
 * with the timezone label always present. The text is Slack mrkdwn (`*…*` is
 * bold); the zone label carries the flag of its country and English times
 * follow that country's clock (AM/PM or 24-hour).
 *
 * A yes/no answer (`point`) is one sentence; it is the draft the LLM phrasing
 * is verified against, so every time and date token it uses is collected in
 * `tokens`. Everything else is posted exactly as rendered (1.2.0): a single
 * day is one line, a range one line per day, windows in the compact
 * "7:00–10:00 AM" form and never split at midnight; a slots answer is one
 * verdict line per asked moment or span.
 */
export interface RenderContext {
  ownerName: string;
  lang: Lang;
  /** Plain label ("New York time"); the renderer adds the flag. */
  zoneLabel: string;
  /** Named in a slot verdict that lies beyond the horizon. */
  horizonWeeks?: number | undefined;
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
    private readonly clock: ClockStyle,
  ) {}
  time(t0: DateTime): string {
    const t = t0.setZone(this.zone);
    const s = formatTime(t, this.lang, this.clock);
    this.tokens.add(s);
    this.timeSequence.push(s);
    return s;
  }
  /** "4:00 PM to 5:30 PM": the full form of a yes/no sentence, every time a token of its own. */
  range(a: DateTime, b: DateTime): string {
    // Format in the display zone, exactly like the tokens (R1-10).
    return `${this.time(a)}${this.lang === 'fr' ? ' à ' : ' to '}${this.time(b)}`;
  }
  /** "7:00–10:00 AM": the compact form of a listing. */
  span(a: DateTime, b: DateTime): string {
    this.time(a);
    this.time(b);
    return formatSpan(a.setZone(this.zone), b.setZone(this.zone), this.lang, this.clock);
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

/** Slack bold. */
const bold = (s: string): string => `*${s}*`;

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

/** The windows of a day in the compact form, "✅ all day" when they cover the working day. */
function dayBody(windows: readonly Interval[], wholeDay: boolean, c: Collector, lang: Lang): string {
  if (wholeDay) {
    const w = windows[0]!;
    return `✅ ${lang === 'fr' ? 'toute la journée' : 'all day'}, ${c.span(w.start, w.end)}`;
  }
  return windows.map((w) => c.span(w.start, w.end)).join(', ');
}

/** The verdict of one asked slot, after the bold label. The allowed qualifiers only: no reason is ever given. */
function slotVerdict(r: SlotResult, c: Collector, ctx: RenderContext, dur: string | null): string {
  const { lang, ownerName } = ctx;
  const fr = lang === 'fr';
  const v: SlotVerdict = r.verdict;
  const weeks = ctx.horizonWeeks ?? 4;
  const spans = (list: readonly Interval[]) => list.map((w) => c.span(w.start, w.end)).join(', ');
  switch (v.kind) {
    case 'past':
      return fr ? 'déjà passé' : 'already past';
    case 'beyond_horizon':
      return fr ? `à plus de ${weeks} semaines` : `more than ${weeks} weeks ahead`;
    case 'no_hours':
      return fr ? 'ne prend pas de rendez-vous ce jour-là' : 'does not take meetings that day';
    case 'outside_hours':
      return fr ? `en dehors des heures habituelles ${frenchDe(ownerName)}` : `outside ${englishPossessive(ownerName)} usual hours`;
    case 'free':
      if (r.slot.end) return fr ? '✅ disponible' : '✅ free';
      return fr ? `✅ disponible jusqu'à ${c.time(v.window.end)}` : `✅ free until ${c.time(v.window.end)}`;
    case 'free_short': {
      const head = fr ? `⚠️ disponible seulement jusqu'à ${c.time(v.window.end)}` : `⚠️ free only until ${c.time(v.window.end)}`;
      if (v.next) return fr ? `${head} ; prochain créneau d'au moins ${dur} : ${spans([v.next])}` : `${head}; next window of at least ${dur}: ${spans([v.next])}`;
      return fr ? `${head} ; aucun autre créneau d'au moins ${dur} ce jour-là` : `${head}; no later window of at least ${dur} that day`;
    }
    case 'partly':
      return fr ? `⚠️ en partie : ${spans(v.windows)}` : `⚠️ partly free: ${spans(v.windows)}`;
    case 'busy': {
      const head = fr ? '❌ pas disponible' : '❌ busy';
      if (!v.next) return head;
      if (dur) return fr ? `${head}, prochain créneau d'au moins ${dur} : ${spans([v.next])}` : `${head}, next window of at least ${dur}: ${spans([v.next])}`;
      return fr ? `${head}, prochain créneau ${spans([v.next])}` : `${head}, next free ${spans([v.next])}`;
    }
  }
}

export function renderResult(res: AvailabilityResult, req: AvailabilityRequest, ctx: RenderContext): Rendered {
  const { lang, ownerName } = ctx;
  const zoneLabel = `${zoneFlag(req.zone)} ${ctx.zoneLabel}`;
  const c = new Collector(lang, req.zone, clockStyle(req.zone));
  const lines: string[] = [];
  // The zone label (flag included) and the owner's name must survive the phrasing (R4-4).
  const required: string[] = [zoneLabel, ownerName];
  const sep = lang === 'fr' ? ' : ' : ': ';

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
          ? `${c.dateLong(p)} à ${bold(c.time(p))} est en dehors des heures habituelles ${frenchDe(ownerName)}, ${zoneLabel}.`
          : `${c.dateLong(p)} at ${bold(c.time(p))} is outside ${englishPossessive(ownerName)} usual hours, ${zoneLabel}.`;
    } else if (v.kind === 'free') {
      polarity = 'yes';
      const tail = dur ? (lang === 'fr' ? ` (au moins ${dur})` : ` (at least ${dur})`) : '';
      text =
        lang === 'fr'
          ? `Oui, ${ownerName} est disponible ${c.dateLong(p)} de ${bold(c.range(v.window.start, v.window.end))}${tail}, ${zoneLabel}.`
          : `Yes, ${ownerName} is free ${c.dateLong(p)} from ${bold(c.range(v.window.start, v.window.end))}${tail}, ${zoneLabel}.`;
    } else if (v.kind === 'free_short') {
      const head =
        lang === 'fr'
          ? `${ownerName} est disponible ${c.dateLong(p)} à ${bold(c.time(v.window.start))} mais seulement jusqu'à ${bold(c.time(v.window.end))}, ${zoneLabel}.`
          : `${ownerName} is free ${c.dateLong(p)} at ${bold(c.time(v.window.start))} but only until ${bold(c.time(v.window.end))}, ${zoneLabel}.`;
      const tail = v.next
        ? lang === 'fr'
          ? ` Prochain créneau d'au moins ${dur} : ${bold(c.range(v.next.start, v.next.end))}.`
          : ` Next window of at least ${dur}: ${bold(c.range(v.next.start, v.next.end))}.`
        : lang === 'fr'
          ? ` Aucun autre créneau d'au moins ${dur} ce jour-là.`
          : ` No later window of at least ${dur} that day.`;
      text = head + tail;
    } else {
      polarity = 'no';
      const head =
        lang === 'fr'
          ? `Non, ${ownerName} n'est pas disponible ${c.dateLong(p)} à ${bold(c.time(p))}.`
          : `No, ${ownerName} is busy ${c.dateLong(p)} at ${bold(c.time(p))}.`;
      const what = dur ? (lang === 'fr' ? `Prochain créneau d'au moins ${dur}` : `Next window of at least ${dur}`) : lang === 'fr' ? 'Prochain créneau' : 'Next free window';
      const tail = v.next
        ? ` ${what}${lang === 'fr' ? ' : ' : ': '}${bold(c.range(v.next.start, v.next.end))}, ${zoneLabel}.`
        : lang === 'fr'
          ? ` Aucune autre disponibilité${dur ? ` d'au moins ${dur}` : ''} ce jour-là, ${zoneLabel}.`
          : ` No other availability${dur ? ` of at least ${dur}` : ''} that day, ${zoneLabel}.`;
      text = head + tail;
    }
    lines.push(text);
    return c.rendered(text, lines, required, polarity);
  }

  if (res.kind === 'slots' && res.slots) {
    // One verdict per asked moment or span, in the order asked; never the day's other windows.
    const dur = req.durationMin ? formatDuration(req.durationMin, lang) : null;
    if (dur) required.push(dur);
    const duration = dur ? (lang === 'fr' ? `, créneaux d'au moins ${dur}` : `, windows of at least ${dur}`) : '';
    lines.push(
      lang === 'fr'
        ? `${bold(`Disponibilités ${frenchDe(ownerName)}`)}${duration}, ${zoneLabel} :`
        : `${bold(`${englishPossessive(ownerName)} availability`)}${duration}, ${zoneLabel}:`,
    );
    for (const r of res.slots) {
      const start = r.slot.start.setZone(req.zone);
      const label = r.slot.end ? `${c.date(start)}, ${c.span(start, r.slot.end)}` : `${c.date(start)}, ${c.time(start)}`;
      lines.push(`• ${bold(label)}${sep}${slotVerdict(r, c, ctx, dur)}`);
    }
    return c.rendered(lines.join('\n'), lines, required, null);
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
      ? `${bold(`Disponibilités ${frenchDe(ownerName)} ${scope}`)}${duration}, ${zoneLabel} :`
      : `${bold(`${englishPossessive(ownerName)} availability ${scope}`)}${duration}, ${zoneLabel}:`;
  if (res.kind === 'day') {
    // A day result carries exactly one day (the kind is derived from the dates, R1-5): one line, windows in order.
    const d = res.days[0]!;
    const text = `${header} ${dayBody(d.windows, d.wholeDay, c, lang)}`;
    lines.push(text);
    return c.rendered(text, lines, required, null);
  }
  lines.push(header);
  for (const d of res.days) {
    const label = bold(c.date(d.day));
    const body = d.windows.length === 0 ? (lang === 'fr' ? 'aucune disponibilité' : 'no availability') : dayBody(d.windows, d.wholeDay, c, lang);
    lines.push(`• ${label}${sep}${body}`);
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
