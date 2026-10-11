import { DateTime } from 'luxon';
import type { BusyInterval, Schedule } from '../calcom/types.js';
import { clipIntervals, mergeIntervals, type Interval } from './intervals.js';
import { dayWorkingIntervals, workingIntervals } from './schedule.js';
import type { Lang } from './timezone.js';
import { classifyPoint, freeWindows, groupByDay, isWholeDayFree, type PointVerdict } from './windows.js';

export type RequestKind = 'point' | 'day' | 'range' | 'open';
export type PartOfDay = 'morning' | 'afternoon' | 'evening';

export interface AvailabilityRequest {
  kind: RequestKind;
  /** Display timezone (asker's, override, or owner's). */
  zone: string;
  lang: Lang;
  now: DateTime;
  point?: DateTime | undefined;
  /** Inclusive first day and exclusive end, as display-zone day starts. */
  rangeStart?: DateTime | undefined;
  rangeEnd?: DateTime | undefined;
  /** luxon weekday numbers, 1 = Monday … 7 = Sunday. */
  excludedWeekdays?: number[] | undefined;
  partOfDay?: PartOfDay | null | undefined;
  durationMin?: number | null | undefined;
}

export interface DayResult {
  day: DateTime;
  windows: Interval[];
  working: Interval[];
  wholeDay: boolean;
}

export interface AvailabilityResult {
  kind: RequestKind;
  verdict?: PointVerdict | undefined;
  days: DayResult[];
  /** Days with availability omitted because of the listing cap. */
  truncated: boolean;
  /** Whether days without availability are listed (short ranges only). */
  showEmptyDays: boolean;
  busyCount: number;
  rangeStart: DateTime;
  rangeEnd: DateTime;
}

export interface EngineSettings {
  noiseFloorMin: number;
  listingCapDays: number;
  openDays: number;
}

export interface EngineDeps {
  schedule: Schedule;
  /** dateFrom/dateTo are schedule-zone dates (YYYY-MM-DD). */
  fetchBusy: (dateFrom: string, dateTo: string, timeZone: string) => Promise<BusyInterval[]>;
  settings: EngineSettings;
}

export const OPEN_DAYS_DEFAULT = 5;
const SHOW_EMPTY_MAX_DAYS = 7;

/** Scope §5.5: morning before 12:00, afternoon from 12:00 onward, evening from 18:00 (R1-8). */
function partOfDaySpan(day: DateTime, part: PartOfDay): Interval {
  if (part === 'morning') return { start: day, end: day.set({ hour: 12 }) };
  if (part === 'afternoon') return { start: day.set({ hour: 12 }), end: day.plus({ days: 1 }) };
  return { start: day.set({ hour: 18 }), end: day.plus({ days: 1 }) };
}

/** Next N days (from today) on which the owner has working hours. */
export function openRange(schedule: Schedule, now: DateTime, zone: string, days: number): { start: DateTime; end: DateTime } {
  const start = now.setZone(zone).startOf('day');
  let day = start;
  let found = 0;
  let scanned = 0;
  while (found < days && scanned < 21) {
    const next = day.plus({ days: 1 });
    const working = clipIntervals(workingIntervals(schedule, day, next), day, next);
    if (working.length && working.some((w) => w.end > now)) found++;
    day = next;
    scanned++;
  }
  return { start, end: day };
}

export async function computeAvailability(deps: EngineDeps, req: AvailabilityRequest): Promise<AvailabilityResult> {
  const zone = req.zone;
  const now = req.now.setZone(zone);
  let rangeStart: DateTime;
  let rangeEnd: DateTime;
  if (req.kind === 'point') {
    const p = req.point!.setZone(zone);
    rangeStart = p.startOf('day');
    rangeEnd = rangeStart.plus({ days: 1 });
  } else if (req.kind === 'open') {
    const r = openRange(deps.schedule, now, zone, deps.settings.openDays);
    rangeStart = r.start;
    rangeEnd = r.end;
  } else {
    rangeStart = req.rangeStart!.setZone(zone).startOf('day');
    rangeEnd = req.rangeEnd!.setZone(zone);
  }

  const schedZone = deps.schedule.timeZone;
  const dateFrom = rangeStart.setZone(schedZone).minus({ days: 1 }).toISODate()!;
  const dateTo = rangeEnd.setZone(schedZone).plus({ days: 1 }).toISODate()!;
  const busyRaw = await deps.fetchBusy(dateFrom, dateTo, schedZone);
  // Every instant is carried in the display zone so that interval arithmetic
  // never mixes zones: an interval boundary borrowed from a busy block must
  // format like one borrowed from the schedule.
  const busy = mergeIntervals(
    busyRaw
      .map((b) => ({ start: DateTime.fromISO(b.start, { setZone: true }).setZone(zone), end: DateTime.fromISO(b.end, { setZone: true }).setZone(zone) }))
      .filter((b) => b.start.isValid && b.end.isValid),
  );

  if (req.kind === 'point') {
    const p = req.point!.setZone(zone);
    const working = workingIntervals(deps.schedule, rangeStart, rangeEnd).map((w) => ({ start: w.start.setZone(zone), end: w.end.setZone(zone) }));
    const verdict = classifyPoint({
      point: p,
      working,
      busy,
      now,
      noiseFloorMin: deps.settings.noiseFloorMin,
      dayStart: rangeStart,
      dayEnd: rangeEnd,
      durationMin: req.durationMin,
    });
    return { kind: 'point', verdict, days: [], truncated: false, showEmptyDays: false, busyCount: busy.length, rangeStart, rangeEnd };
  }

  const working = workingIntervals(deps.schedule, rangeStart, rangeEnd).map((w) => ({ start: w.start.setZone(zone), end: w.end.setZone(zone) }));
  let free = freeWindows({
    working,
    busy,
    rangeStart,
    rangeEnd,
    now,
    noiseFloorMin: deps.settings.noiseFloorMin,
    durationMin: req.durationMin,
  });
  if (req.partOfDay) {
    const clipped: Interval[] = [];
    for (const g of groupByDay(free, zone)) {
      const span = partOfDaySpan(g.day, req.partOfDay);
      clipped.push(...clipIntervals(g.windows, span.start, span.end));
    }
    const minLen = Math.max(deps.settings.noiseFloorMin, req.durationMin ?? 0);
    free = clipped.filter((w) => w.end.diff(w.start, 'minutes').minutes >= minLen);
  }
  const groups = new Map(groupByDay(free, zone).map((g) => [g.date, g]));
  const excluded = new Set(req.excludedWeekdays ?? []);
  const totalDays = Math.round(rangeEnd.diff(rangeStart, 'days').days);
  const showEmptyDays = totalDays <= SHOW_EMPTY_MAX_DAYS;
  const days: DayResult[] = [];
  let withAvailability = 0;
  let truncated = false;
  for (let day = rangeStart; day < rangeEnd; day = day.plus({ days: 1 })) {
    if (excluded.has(day.weekday)) continue;
    const dayEnd = day.plus({ days: 1 });
    const dayWorking = clipIntervals(
      dayWorkingIntervals(deps.schedule, day).concat(dayWorkingIntervals(deps.schedule, day.minus({ days: 1 })), dayWorkingIntervals(deps.schedule, dayEnd)),
      day,
      dayEnd,
    ).map((w) => ({ start: w.start.setZone(zone), end: w.end.setZone(zone) }));
    if (dayWorking.length === 0) continue; // no hours that day: never listed
    if (dayEnd <= now) continue; // fully past
    const windows = groups.get(day.toISODate()!)?.windows ?? [];
    if (windows.length === 0 && !showEmptyDays) continue;
    if (windows.length > 0) {
      if (withAvailability >= deps.settings.listingCapDays) {
        truncated = true;
        continue;
      }
      withAvailability++;
    }
    days.push({ day, windows, working: mergeIntervals(dayWorking), wholeDay: windows.length > 0 && !req.partOfDay && isWholeDayFree(windows, dayWorking) });
  }
  return { kind: req.kind, days, truncated, showEmptyDays, busyCount: busy.length, rangeStart, rangeEnd };
}
