import { DateTime } from 'luxon';

export interface Interval {
  start: DateTime;
  end: DateTime;
}

export function minutes(i: Interval): number {
  return i.end.diff(i.start, 'minutes').minutes;
}

/** Sort by start and merge overlapping or touching intervals. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].filter((i) => i.end > i.start).sort((a, b) => a.start.toMillis() - b.start.toMillis());
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

/** base minus remove, both arbitrary lists. */
export function subtractIntervals(base: readonly Interval[], remove: readonly Interval[]): Interval[] {
  const blocks = mergeIntervals(remove);
  const out: Interval[] = [];
  for (const b of mergeIntervals(base)) {
    let cursor = b.start;
    for (const r of blocks) {
      if (r.end <= cursor) continue;
      if (r.start >= b.end) break;
      if (r.start > cursor) out.push({ start: cursor, end: r.start });
      if (r.end > cursor) cursor = r.end;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}

export function clipIntervals(list: readonly Interval[], start: DateTime, end: DateTime): Interval[] {
  const out: Interval[] = [];
  for (const i of list) {
    const s = i.start > start ? i.start : start;
    const e = i.end < end ? i.end : end;
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}

export function contains(i: Interval, t: DateTime): boolean {
  return t >= i.start && t < i.end;
}

export function roundUpToMinutes(t: DateTime, step: number): DateTime {
  const floored = t.startOf('minute');
  const extra = floored.minute % step;
  const base = extra === 0 && floored.equals(t) ? floored : floored.plus({ minutes: step - extra });
  return base;
}
