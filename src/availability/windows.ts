import { DateTime } from 'luxon';
import {
  clipIntervals,
  contains,
  mergeIntervals,
  minutes,
  roundUpToMinutes,
  subtractIntervals,
  type Interval,
} from './intervals.js';

export const NOW_ROUNDING_MINUTES = 5;

export interface FreeWindowsInput {
  working: readonly Interval[];
  busy: readonly Interval[];
  rangeStart: DateTime;
  rangeEnd: DateTime;
  now: DateTime;
  noiseFloorMin: number;
  durationMin?: number | null | undefined;
}

/**
 * Free windows = working − busy, clipped to the range and to "now" rounded up
 * to five minutes, gaps under the noise floor dropped, windows shorter than a
 * requested duration dropped, adjacent windows merged.
 */
export function freeWindows(i: FreeWindowsInput): Interval[] {
  const notBefore = roundUpToMinutes(i.now, NOW_ROUNDING_MINUTES);
  const start = i.rangeStart > notBefore ? i.rangeStart : notBefore;
  if (i.rangeEnd <= start) return [];
  const working = clipIntervals(mergeIntervals(i.working), start, i.rangeEnd);
  const busy = clipIntervals(mergeIntervals(i.busy), start, i.rangeEnd);
  const minLen = Math.max(i.noiseFloorMin, i.durationMin ?? 0);
  return mergeIntervals(subtractIntervals(working, busy)).filter((w) => minutes(w) >= minLen);
}

export interface DayGroup {
  /** Start of the display-zone day. */
  day: DateTime;
  date: string;
  windows: Interval[];
}

/** One working span of the schedule (one schedule-zone day, or one of its rules), carried in the display zone. */
export interface WorkingDay {
  /** Start of the display-zone day the span starts in. */
  day: DateTime;
  interval: Interval;
}

/**
 * Group free windows by the working day they fall in (1.2.0). A window
 * belongs to the display-zone day on which its working span started, never
 * to the calendar day of its own start: a New York working day seen from
 * Paris reads "13:00–01:00" on one line, and a free hour at 00:00 after a
 * late block still belongs to that day instead of opening the next one with a
 * "00:00–01:00" fragment. A span that started before `from` and is still
 * running at `now` is attached to now's day, so "today" keeps what is
 * available right now. A window outside every span (never, in practice)
 * belongs to the day it starts.
 */
export function groupByWorkingDay(windows: readonly Interval[], workingDays: readonly WorkingDay[], zone: string, now: DateTime, from: DateTime): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const w of windows) {
    const start = w.start.setZone(zone);
    const span = workingDays.find((k) => contains(k.interval, start));
    let day = span ? span.day : start.startOf('day');
    if (span && span.interval.start < from && contains(span.interval, now)) day = now.setZone(zone).startOf('day');
    const date = day.toISODate()!;
    let g = groups.get(date);
    if (!g) {
      g = { day, date, windows: [] };
      groups.set(date, g);
    }
    g.windows.push({ start, end: w.end.setZone(zone) });
  }
  return [...groups.values()].sort((a, b) => a.day.toMillis() - b.day.toMillis());
}

export type PointVerdict =
  | { kind: 'past' }
  | { kind: 'no_hours' }
  | { kind: 'outside_hours' }
  | { kind: 'free'; window: Interval }
  /** Free at the point, but the window is shorter than the requested duration. */
  | { kind: 'free_short'; window: Interval; next: Interval | null }
  | { kind: 'busy'; next: Interval | null };

/** A span ("Monday 12 to 4") adds one outcome: free for part of it only. */
export type SpanVerdict = PointVerdict | { kind: 'partly'; windows: Interval[] };

/** One line of a slots answer; the horizon is checked by the engine before any lookup. */
export type SlotVerdict = SpanVerdict | { kind: 'beyond_horizon' };

export interface PointInput {
  point: DateTime;
  /**
   * Working intervals overlapping the display-zone day of the point, not
   * clipped to it: a working day that ends after midnight is answered "free
   * until 01:00", not "until 00:00".
   */
  working: readonly Interval[];
  busy: readonly Interval[];
  now: DateTime;
  noiseFloorMin: number;
  dayStart: DateTime;
  dayEnd: DateTime;
  durationMin?: number | null | undefined;
}

/** The working intervals that touch the day, merged, whole. */
function dayWorking(i: Pick<PointInput, 'working' | 'dayStart' | 'dayEnd'>): Interval[] {
  return mergeIntervals(i.working).filter((w) => w.end > i.dayStart && w.start < i.dayEnd);
}

/**
 * Free windows of the day for a lookup. They are not clipped to "now":
 * futureness is already settled by the caller, and clipping to now rounded up
 * would make a point in the next five minutes busy (R1-1). The range runs one
 * day past the display day so that a window crossing midnight keeps its end.
 */
function dayFree(i: Pick<PointInput, 'busy' | 'dayStart' | 'dayEnd' | 'noiseFloorMin'>, working: Interval[]): Interval[] {
  return freeWindows({
    working,
    busy: i.busy,
    rangeStart: i.dayStart,
    rangeEnd: i.dayEnd.plus({ days: 1 }),
    now: i.dayStart,
    noiseFloorMin: i.noiseFloorMin,
  });
}

export function classifyPoint(i: PointInput): PointVerdict {
  // Minute precision: "at 10:00" asked at 10:00:30 is not in the past (R1-1).
  if (i.point < i.now.startOf('minute')) return { kind: 'past' };
  const working = dayWorking(i);
  if (working.length === 0) return { kind: 'no_hours' };
  if (!working.some((w) => contains(w, i.point))) return { kind: 'outside_hours' };
  const free = dayFree(i, working);
  const here = free.find((w) => contains(w, i.point));
  const fits = (w: Interval) => !i.durationMin || minutes(w) >= i.durationMin;
  // "Next" stays on the asked day: a window starting after midnight belongs to the next one.
  const later = (w: Interval) => w.start > i.point && w.start < i.dayEnd && fits(w);
  if (here) {
    const window = { start: i.point, end: here.end };
    if (fits(window)) return { kind: 'free', window };
    return { kind: 'free_short', window, next: free.find(later) ?? null };
  }
  return { kind: 'busy', next: free.find(later) ?? null };
}

export interface SpanInput extends Omit<PointInput, 'point'> {
  span: Interval;
}

/**
 * A span is free when free windows cover it entirely, busy when none touches
 * it (then the next window of the day is named), partly free otherwise, with
 * the free parts listed. A span already started is judged from now on.
 */
export function classifySpan(i: SpanInput): SpanVerdict {
  const nowMin = i.now.startOf('minute');
  if (i.span.end <= nowMin) return { kind: 'past' };
  const from = i.span.start >= nowMin ? i.span.start : roundUpToMinutes(i.now, NOW_ROUNDING_MINUTES);
  if (from >= i.span.end) return { kind: 'past' };
  const span = { start: from, end: i.span.end };
  const working = dayWorking(i);
  if (working.length === 0) return { kind: 'no_hours' };
  if (!working.some((w) => w.start < span.end && w.end > span.start)) return { kind: 'outside_hours' };
  const free = dayFree(i, working);
  const inside = clipIntervals(free, span.start, span.end);
  const whole = inside.length === 1 && inside[0]!.start.toMillis() === span.start.toMillis() && inside[0]!.end.toMillis() === span.end.toMillis();
  if (whole) return { kind: 'free', window: span };
  const minLen = Math.max(i.noiseFloorMin, i.durationMin ?? 0);
  const parts = inside.filter((w) => minutes(w) >= minLen);
  if (parts.length > 0) return { kind: 'partly', windows: parts };
  const fits = (w: Interval) => !i.durationMin || minutes(w) >= i.durationMin;
  // The next window of the day: the first free time after the span, a window
  // that overlaps the span's tail counted from the span's end.
  const next =
    free
      .map((w) => ({ start: w.start > span.end ? w.start : span.end, end: w.end }))
      .find((w) => w.end > w.start && w.start < i.dayEnd && fits(w)) ?? null;
  return { kind: 'busy', next };
}

/** A day is "all day free" when its windows exactly cover its working intervals (single span). */
export function isWholeDayFree(dayWindows: readonly Interval[], dayWorking: readonly Interval[]): boolean {
  const w = mergeIntervals(dayWindows);
  const k = mergeIntervals(dayWorking);
  if (w.length !== 1 || k.length !== 1) return false;
  // Compare instants, not DateTime objects: luxon's equals() also compares zones (R1-3).
  return w[0]!.start.toMillis() === k[0]!.start.toMillis() && w[0]!.end.toMillis() === k[0]!.end.toMillis();
}
