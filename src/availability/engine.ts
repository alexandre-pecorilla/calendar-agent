import { DateTime } from 'luxon';
import type { BusyInterval, Schedule } from '../calcom/types.js';
import { clipIntervals, mergeIntervals, type Interval } from './intervals.js';
import { dayWorkingIntervals, workingIntervals } from './schedule.js';
import type { Lang } from './timezone.js';
import { classifyPoint, classifySpan, freeWindows, groupByWorkingDay, isWholeDayFree, type PointVerdict, type SlotVerdict, type WorkingDay } from './windows.js';

export type RequestKind = 'point' | 'day' | 'range' | 'open' | 'slots';
export type PartOfDay = 'morning' | 'afternoon' | 'evening';

/** One asked moment ("Tuesday at 4") or span ("Monday 12 to 4"), in the display zone. */
export interface Slot {
  start: DateTime;
  end?: DateTime | undefined;
}

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
  /** The asked slots, in the order asked. */
  slots?: Slot[] | undefined;
  /** Exclusive end of the horizon; a slot at or after it is "beyond_horizon". */
  horizonEnd?: DateTime | undefined;
}

export interface DayResult {
  day: DateTime;
  windows: Interval[];
  working: Interval[];
  wholeDay: boolean;
}

export interface SlotResult {
  slot: Slot;
  verdict: SlotVerdict;
}

export interface AvailabilityResult {
  kind: RequestKind;
  verdict?: PointVerdict | undefined;
  slots?: SlotResult[] | undefined;
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

/**
 * Scope §5.5: morning before 12:00, afternoon from 12:00 onward, evening from
 * 18:00 (R1-8). Afternoon and evening have no end: a window that runs past
 * midnight stays whole (1.2.0).
 */
function partOfDaySpan(day: DateTime, part: PartOfDay): Interval {
  const open = day.plus({ days: 2 });
  if (part === 'morning') return { start: day, end: day.set({ hour: 12 }) };
  if (part === 'afternoon') return { start: day.set({ hour: 12 }), end: open };
  return { start: day.set({ hour: 18 }), end: open };
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

/** A slot's own display-zone day. */
function slotDay(slot: Slot, zone: string): { dayStart: DateTime; dayEnd: DateTime } {
  const dayStart = slot.start.setZone(zone).startOf('day');
  return { dayStart, dayEnd: dayStart.plus({ days: 1 }) };
}

export async function computeAvailability(deps: EngineDeps, req: AvailabilityRequest): Promise<AvailabilityResult> {
  const zone = req.zone;
  const now = req.now.setZone(zone);
  const nowMin = now.startOf('minute');
  let rangeStart: DateTime;
  let rangeEnd: DateTime;
  // Slots that need no lookup (past, beyond the horizon) are left out of the fetched range.
  const lookedUp = (req.slots ?? []).filter((s) => !(req.horizonEnd && s.start >= req.horizonEnd) && (s.end ?? s.start) > nowMin);
  if (req.kind === 'point') {
    const p = req.point!.setZone(zone);
    rangeStart = p.startOf('day');
    rangeEnd = rangeStart.plus({ days: 1 });
  } else if (req.kind === 'slots') {
    const days = lookedUp.map((s) => slotDay(s, zone));
    rangeStart = days.length ? days.reduce((a, d) => (d.dayStart < a ? d.dayStart : a), days[0]!.dayStart) : now.startOf('day');
    rangeEnd = days.length ? days.reduce((a, d) => (d.dayEnd > a ? d.dayEnd : a), days[0]!.dayEnd) : rangeStart.plus({ days: 1 });
  } else if (req.kind === 'open') {
    const r = openRange(deps.schedule, now, zone, deps.settings.openDays);
    rangeStart = r.start;
    rangeEnd = r.end;
  } else {
    rangeStart = req.rangeStart!.setZone(zone).startOf('day');
    rangeEnd = req.rangeEnd!.setZone(zone);
  }
  // Intervals are computed one day wider on each side so that a window
  // crossing midnight keeps both ends; the listing then keeps the windows
  // that start inside the asked range.
  const computeStart = rangeStart.minus({ days: 1 });
  const computeEnd = rangeEnd.plus({ days: 1 });

  const schedZone = deps.schedule.timeZone;
  const dateFrom = computeStart.setZone(schedZone).minus({ days: 1 }).toISODate()!;
  const dateTo = computeEnd.setZone(schedZone).plus({ days: 1 }).toISODate()!;
  const needsBusy = req.kind !== 'slots' || lookedUp.length > 0;
  const busyRaw = needsBusy ? await deps.fetchBusy(dateFrom, dateTo, schedZone) : [];
  // Every instant is carried in the display zone so that interval arithmetic
  // never mixes zones: an interval boundary borrowed from a busy block must
  // format like one borrowed from the schedule.
  const busy = mergeIntervals(
    busyRaw
      .map((b) => ({ start: DateTime.fromISO(b.start, { setZone: true }).setZone(zone), end: DateTime.fromISO(b.end, { setZone: true }).setZone(zone) }))
      .filter((b) => b.start.isValid && b.end.isValid),
  );
  const working = workingIntervals(deps.schedule, computeStart, computeEnd).map((w) => ({ start: w.start.setZone(zone), end: w.end.setZone(zone) }));
  const base = { kind: req.kind, days: [], truncated: false, showEmptyDays: false, busyCount: busy.length, rangeStart, rangeEnd } satisfies AvailabilityResult;

  if (req.kind === 'point') {
    const p = req.point!.setZone(zone);
    const verdict = classifyPoint({ point: p, working, busy, now, noiseFloorMin: deps.settings.noiseFloorMin, dayStart: rangeStart, dayEnd: rangeEnd, durationMin: req.durationMin });
    return { ...base, verdict };
  }

  if (req.kind === 'slots') {
    const slots: SlotResult[] = (req.slots ?? []).map((slot) => {
      if (req.horizonEnd && slot.start >= req.horizonEnd) return { slot, verdict: { kind: 'beyond_horizon' } };
      const { dayStart, dayEnd } = slotDay(slot, zone);
      const common = { working, busy, now, noiseFloorMin: deps.settings.noiseFloorMin, dayStart, dayEnd, durationMin: req.durationMin };
      const verdict: SlotVerdict = slot.end
        ? classifySpan({ ...common, span: { start: slot.start.setZone(zone), end: slot.end.setZone(zone) } })
        : classifyPoint({ ...common, point: slot.start.setZone(zone) });
      return { slot, verdict };
    });
    return { ...base, slots };
  }

  // Computed one day wider on each side; a window counts for the day of its
  // working span, so only the days of the asked range are read below.
  const free = freeWindows({
    working,
    busy,
    rangeStart: computeStart,
    rangeEnd: computeEnd,
    now,
    noiseFloorMin: deps.settings.noiseFloorMin,
    durationMin: req.durationMin,
  });
  // The working days of the schedule, one span per schedule-zone day (or per
  // rule of a split day), keyed by the display-zone day the span starts in.
  const workingDays: WorkingDay[] = [];
  const lastSchedDay = computeEnd.setZone(schedZone).startOf('day');
  for (let d = computeStart.setZone(schedZone).startOf('day').minus({ days: 1 }); d <= lastSchedDay; d = d.plus({ days: 1 })) {
    for (const k of dayWorkingIntervals(deps.schedule, d)) {
      const start = k.start.setZone(zone);
      workingDays.push({ day: start.startOf('day'), interval: { start, end: k.end.setZone(zone) } });
    }
  }
  let groups = groupByWorkingDay(free, workingDays, zone, now, rangeStart);
  if (req.partOfDay) {
    const part = req.partOfDay;
    const minLen = Math.max(deps.settings.noiseFloorMin, req.durationMin ?? 0);
    groups = groups
      .map((g) => {
        const span = partOfDaySpan(g.day, part);
        return { ...g, windows: clipIntervals(g.windows, span.start, span.end).filter((w) => w.end.diff(w.start, 'minutes').minutes >= minLen) };
      })
      .filter((g) => g.windows.length > 0);
  }
  const byDate = new Map(groups.map((g) => [g.date, g]));
  const workingByDay = new Map<string, Interval[]>();
  for (const wd of workingDays) {
    const key = wd.day.toISODate()!;
    workingByDay.set(key, [...(workingByDay.get(key) ?? []), wd.interval]);
  }
  const excluded = new Set(req.excludedWeekdays ?? []);
  const totalDays = Math.round(rangeEnd.diff(rangeStart, 'days').days);
  const showEmptyDays = totalDays <= SHOW_EMPTY_MAX_DAYS;
  const days: DayResult[] = [];
  let withAvailability = 0;
  let truncated = false;
  for (let day = rangeStart; day < rangeEnd; day = day.plus({ days: 1 })) {
    if (excluded.has(day.weekday)) continue;
    const dayEnd = day.plus({ days: 1 });
    const dayWorking = mergeIntervals(workingByDay.get(day.toISODate()!) ?? []);
    const windows = byDate.get(day.toISODate()!)?.windows ?? [];
    if (dayWorking.length === 0 && windows.length === 0) continue; // no hours that day: never listed (unless a running day's tail belongs to today)
    if (dayEnd <= now) continue; // fully past
    if (windows.length === 0 && !showEmptyDays) continue;
    if (windows.length > 0) {
      if (withAvailability >= deps.settings.listingCapDays) {
        truncated = true;
        continue;
      }
      withAvailability++;
    }
    days.push({ day, windows, working: dayWorking, wholeDay: windows.length > 0 && !req.partOfDay && isWholeDayFree(windows, dayWorking) });
  }
  return { ...base, days, truncated, showEmptyDays };
}
