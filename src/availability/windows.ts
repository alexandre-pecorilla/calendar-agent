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

/** Group windows by display-zone day; a window crossing midnight is split. */
export function groupByDay(windows: readonly Interval[], zone: string): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const w of windows) {
    let cursor = w.start.setZone(zone);
    const end = w.end.setZone(zone);
    while (cursor < end) {
      const dayStart = cursor.startOf('day');
      const nextDay = dayStart.plus({ days: 1 });
      const segEnd = end < nextDay ? end : nextDay;
      const date = dayStart.toISODate()!;
      let g = groups.get(date);
      if (!g) {
        g = { day: dayStart, date, windows: [] };
        groups.set(date, g);
      }
      g.windows.push({ start: cursor, end: segEnd });
      cursor = segEnd;
    }
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

export interface PointInput {
  point: DateTime;
  /** Working intervals covering the display-zone day of the point. */
  working: readonly Interval[];
  busy: readonly Interval[];
  now: DateTime;
  noiseFloorMin: number;
  dayStart: DateTime;
  dayEnd: DateTime;
  durationMin?: number | null | undefined;
}

export function classifyPoint(i: PointInput): PointVerdict {
  // Minute precision: "at 10:00" asked at 10:00:30 is not in the past (R1-1).
  if (i.point < i.now.startOf('minute')) return { kind: 'past' };
  const working = clipIntervals(mergeIntervals(i.working), i.dayStart, i.dayEnd);
  if (working.length === 0) return { kind: 'no_hours' };
  if (!working.some((w) => contains(w, i.point))) return { kind: 'outside_hours' };
  // Lookup windows are not clipped to "now": futureness is already settled, and
  // clipping to now rounded up would make a point in the next five minutes busy (R1-1).
  const free = freeWindows({
    working,
    busy: i.busy,
    rangeStart: i.dayStart,
    rangeEnd: i.dayEnd,
    now: i.dayStart,
    noiseFloorMin: i.noiseFloorMin,
  });
  const here = free.find((w) => contains(w, i.point));
  const fits = (w: Interval) => !i.durationMin || minutes(w) >= i.durationMin;
  if (here) {
    const window = { start: i.point, end: here.end };
    if (fits(window)) return { kind: 'free', window };
    const next = free.find((w) => w.start > i.point && fits(w)) ?? null;
    return { kind: 'free_short', window, next };
  }
  const next = free.find((w) => w.start > i.point && fits(w)) ?? null;
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
