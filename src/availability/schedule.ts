import { DateTime } from 'luxon';
import type { Schedule } from '../calcom/types.js';
import { clipIntervals, mergeIntervals, type Interval } from './intervals.js';

/**
 * Working intervals from the Cal.com default schedule: weekly rules by
 * weekday, date overrides replacing a date entirely, all evaluated in the
 * schedule's own timezone and returned as absolute intervals clipped to the
 * requested absolute range. The display timezone may differ, so the range is
 * widened by a day on each side before clipping.
 */

function parseHHMM(day: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  if (h === 24 && m === 0) return day.plus({ days: 1 }).startOf('day');
  return day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

export function dayWorkingIntervals(schedule: Schedule, day: DateTime): Interval[] {
  const zone = schedule.timeZone;
  const d = day.setZone(zone).startOf('day');
  const date = d.toISODate();
  const overrides = schedule.overrides.filter((o) => o.date === date);
  const rules = overrides.length
    ? overrides.map((o) => ({ startTime: o.startTime, endTime: o.endTime }))
    : schedule.availability
        .filter((a) => a.days.includes(d.setLocale('en').weekdayLong as (typeof a.days)[number]))
        .map((a) => ({ startTime: a.startTime, endTime: a.endTime }));
  const out: Interval[] = [];
  for (const r of rules) {
    const start = parseHHMM(d, r.startTime);
    const end = parseHHMM(d, r.endTime);
    if (end > start) out.push({ start, end });
  }
  return mergeIntervals(out);
}

export function workingIntervals(schedule: Schedule, rangeStart: DateTime, rangeEnd: DateTime): Interval[] {
  const zone = schedule.timeZone;
  let day = rangeStart.setZone(zone).startOf('day').minus({ days: 1 });
  const last = rangeEnd.setZone(zone).startOf('day').plus({ days: 1 });
  const out: Interval[] = [];
  while (day <= last) {
    out.push(...dayWorkingIntervals(schedule, day));
    day = day.plus({ days: 1 });
  }
  return clipIntervals(mergeIntervals(out), rangeStart, rangeEnd);
}

/** Does the owner have any working hours inside this absolute span (a display-zone day, typically)? */
export function hasHours(schedule: Schedule, spanStart: DateTime, spanEnd: DateTime): boolean {
  return workingIntervals(schedule, spanStart, spanEnd).length > 0;
}
