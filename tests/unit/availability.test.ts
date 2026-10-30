import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { computeAvailability, openRange, type AvailabilityRequest } from '../../src/availability/engine.js';
import { formatDate, formatDateLong, formatDuration, formatRange, formatSpan, formatTime } from '../../src/availability/format.js';
import { clipIntervals, mergeIntervals, minutes, roundUpToMinutes, subtractIntervals } from '../../src/availability/intervals.js';
import { renderResult } from '../../src/availability/render.js';
import { verifyReply } from '../../src/llm/verify.js';
import { dayWorkingIntervals, workingIntervals } from '../../src/availability/schedule.js';
import { isValidZone, normalizeZoneOverride, resolveZone, zoneLabel, clockStyle, zoneFlag } from '../../src/availability/timezone.js';
import { ZONE_COUNTRIES } from '../../src/availability/zone-countries.js';
import { classifyPoint, classifySpan, freeWindows, groupByWorkingDay, isWholeDayFree } from '../../src/availability/windows.js';
import { midnightEnd, newYorkAllWeek, parisOfficeHours, splitHours, withOverride } from '../fixtures/schedules.js';

const P = 'Europe/Paris';
const NY = 'America/New_York';
const t = (iso: string, zone = P) => DateTime.fromISO(iso, { zone });
const iv = (a: string, b: string, zone = P) => ({ start: t(a, zone), end: t(b, zone) });

describe('intervals', () => {
  it('merges overlapping and touching intervals', () => {
    const m = mergeIntervals([iv('2026-10-13T10:00', '2026-10-13T11:00'), iv('2026-10-13T09:00', '2026-10-13T10:00'), iv('2026-10-13T10:30', '2026-10-13T12:00'), iv('2026-10-13T13:00', '2026-10-13T12:00')]);
    expect(m.map((x) => [x.start.toISO(), x.end.toISO()])).toEqual([[t('2026-10-13T09:00').toISO(), t('2026-10-13T12:00').toISO()]]);
  });
  it('subtracts, clips, measures and rounds', () => {
    const base = [iv('2026-10-13T09:00', '2026-10-13T17:00')];
    const r = subtractIntervals(base, [iv('2026-10-13T10:00', '2026-10-13T11:00'), iv('2026-10-13T16:30', '2026-10-13T18:00')]);
    expect(r.map((x) => formatRange(x.start, x.end, 'fr'))).toEqual(['9h00 à 10h00', '11h00 à 16h30']);
    expect(clipIntervals(base, t('2026-10-13T12:00'), t('2026-10-13T13:00'))).toHaveLength(1);
    expect(minutes(iv('2026-10-13T09:00', '2026-10-13T09:45'))).toBe(45);
    expect(roundUpToMinutes(t('2026-10-13T09:01:30'), 5).toFormat('HH:mm')).toBe('09:05');
    expect(roundUpToMinutes(t('2026-10-13T09:05:00'), 5).toFormat('HH:mm')).toBe('09:05');
  });
});

describe('schedule', () => {
  it('builds weekday rules, skips days without rules, applies overrides and 24:00', () => {
    expect(dayWorkingIntervals(parisOfficeHours, t('2026-10-13'))).toHaveLength(1); // Tuesday
    expect(dayWorkingIntervals(parisOfficeHours, t('2026-10-17'))).toHaveLength(0); // Saturday
    const o = dayWorkingIntervals(withOverride, t('2026-10-14'));
    expect(o.map((x) => formatRange(x.start, x.end, 'fr'))).toEqual(['13h00 à 15h00']);
    const m = dayWorkingIntervals(midnightEnd, t('2026-10-13'));
    expect(m[0]!.end.toISO()).toBe(t('2026-10-14T00:00').toISO());
    expect(dayWorkingIntervals(splitHours, t('2026-10-13'))).toHaveLength(2);
  });
  it('clips to the absolute range across zones', () => {
    const w = workingIntervals(parisOfficeHours, t('2026-10-13T00:00', NY), t('2026-10-14T00:00', NY));
    // Paris 09:00–17:00 Tuesday = 03:00–11:00 New York Tuesday; Wednesday 09:00 Paris = 03:00 NY Wednesday (outside)
    expect(w.map((x) => formatRange(x.start.setZone(NY), x.end.setZone(NY), 'en'))).toEqual(['3:00 AM to 11:00 AM']);
  });
  it('spans a DST change without losing real time', () => {
    const s = { ...parisOfficeHours, availability: [{ days: ['Sunday' as const], startTime: '01:00', endTime: '05:00' }] };
    const w = dayWorkingIntervals(s, t('2026-10-25'));
    expect(minutes(w[0]!)).toBe(300);
    const ny = { ...newYorkAllWeek, availability: [{ days: ['Sunday' as const], startTime: '00:00', endTime: '06:00' }] };
    expect(minutes(dayWorkingIntervals(ny, t('2026-11-01', NY))[0]!)).toBe(420);
  });
});

describe('free windows', () => {
  const working = [iv('2026-10-13T09:00', '2026-10-13T17:00')];
  const base = { working, rangeStart: t('2026-10-13T00:00'), rangeEnd: t('2026-10-14T00:00'), now: t('2026-10-12T12:00'), noiseFloorMin: 15 };
  it('drops gaps under the noise floor and keeps 15-minute ones', () => {
    const w = freeWindows({ ...base, busy: [iv('2026-10-13T10:00', '2026-10-13T11:00'), iv('2026-10-13T11:10', '2026-10-13T12:00')] });
    expect(w.map((x) => formatRange(x.start, x.end, 'fr'))).toEqual(['9h00 à 10h00', '12h00 à 17h00']);
    const w2 = freeWindows({ ...base, busy: [iv('2026-10-13T10:00', '2026-10-13T11:00'), iv('2026-10-13T11:15', '2026-10-13T12:00')] });
    expect(w2.map((x) => formatRange(x.start, x.end, 'fr'))).toEqual(['9h00 à 10h00', '11h00 à 11h15', '12h00 à 17h00']);
  });
  it('clips to now rounded up and applies a duration filter', () => {
    const w = freeWindows({ ...base, busy: [iv('2026-10-13T10:00', '2026-10-13T10:45')], now: t('2026-10-13T09:31') });
    expect(w.map((x) => formatRange(x.start, x.end, 'fr'))).toEqual(['9h35 à 10h00', '10h45 à 17h00']);
    const d = freeWindows({ ...base, busy: [iv('2026-10-13T11:30', '2026-10-13T16:00')], durationMin: 60 });
    expect(d.map((x) => formatRange(x.start, x.end, 'fr'))).toEqual(['9h00 à 11h30', '16h00 à 17h00']);
    const d2 = freeWindows({ ...base, busy: [iv('2026-10-13T10:00', '2026-10-13T16:15')], durationMin: 60 });
    expect(d2.map((x) => formatRange(x.start, x.end, 'fr'))).toEqual(['9h00 à 10h00']);
  });
  it('handles overlapping, nested and all-day busy blocks', () => {
    const w = freeWindows({ ...base, busy: [iv('2026-10-13T10:00', '2026-10-13T12:00'), iv('2026-10-13T11:00', '2026-10-13T11:30'), iv('2026-10-13T11:45', '2026-10-13T13:00')] });
    expect(w.map((x) => formatRange(x.start, x.end, 'fr'))).toEqual(['9h00 à 10h00', '13h00 à 17h00']);
    expect(freeWindows({ ...base, busy: [iv('2026-10-13T00:00', '2026-10-14T00:00')] })).toEqual([]);
    expect(freeWindows({ ...base, busy: [] })).toHaveLength(1);
  });
  it('1.2.0: groups windows by the working day they fall in, never splitting at midnight; a running day belongs to today', () => {
    // Working days 20:00–02:00 on the 13th and the 14th (Paris); a free hour at 00:00 on the 14th belongs to the 13th's day.
    const days = [
      { day: t('2026-10-13'), interval: iv('2026-10-13T20:00', '2026-10-14T02:00') },
      { day: t('2026-10-14'), interval: iv('2026-10-14T20:00', '2026-10-15T02:00') },
    ];
    const windows = [iv('2026-10-13T22:00', '2026-10-13T23:00'), iv('2026-10-14T00:00', '2026-10-14T01:00'), iv('2026-10-14T20:00', '2026-10-15T02:00')];
    const g = groupByWorkingDay(windows, days, P, t('2026-10-12T12:00'), t('2026-10-13'));
    expect(g.map((x) => [x.date, x.windows.map((w) => formatRange(w.start, w.end, 'fr'))])).toEqual([
      ['2026-10-13', ['22h00 à 23h00', '0h00 à 1h00']],
      ['2026-10-14', ['20h00 à 2h00']],
    ]);
    // Asked "today" (the 14th) at 00:20 while the 13th's day still runs: its remaining windows are today's.
    const running = groupByWorkingDay([iv('2026-10-14T00:20', '2026-10-14T01:00'), iv('2026-10-14T20:00', '2026-10-15T02:00')], days, P, t('2026-10-14T00:20'), t('2026-10-14'));
    expect(running.map((x) => [x.date, x.windows.length])).toEqual([['2026-10-14', 2]]);
    // A window outside every span falls back to its own day.
    expect(groupByWorkingDay([iv('2026-10-20T09:00', '2026-10-20T10:00')], days, P, t('2026-10-12T12:00'), t('2026-10-13'))[0]!.date).toBe('2026-10-20');
  });
  it('detects a whole free day', () => {
    expect(isWholeDayFree(working, working)).toBe(true);
    expect(isWholeDayFree([iv('2026-10-13T09:00', '2026-10-13T16:00')], working)).toBe(false);
  });
});

describe('point classification', () => {
  const working = [iv('2026-10-13T09:00', '2026-10-13T17:00')];
  const day = { dayStart: t('2026-10-13T00:00'), dayEnd: t('2026-10-14T00:00'), now: t('2026-10-12T12:00'), noiseFloorMin: 15, working };
  it('free inside a window with the window end', () => {
    const v = classifyPoint({ ...day, point: t('2026-10-13T16:00'), busy: [iv('2026-10-13T17:30', '2026-10-13T18:00')] });
    expect(v.kind).toBe('free');
    if (v.kind === 'free') expect(formatRange(v.window.start, v.window.end, 'en')).toBe('4:00 PM to 5:00 PM');
  });
  it('busy with the next window, or none', () => {
    const v = classifyPoint({ ...day, point: t('2026-10-13T16:00'), busy: [iv('2026-10-13T15:30', '2026-10-13T16:30')] });
    expect(v.kind).toBe('busy');
    if (v.kind === 'busy') expect(formatRange(v.next!.start, v.next!.end, 'en')).toBe('4:30 PM to 5:00 PM');
    const v2 = classifyPoint({ ...day, point: t('2026-10-13T16:00'), busy: [iv('2026-10-13T15:30', '2026-10-13T17:00')] });
    expect(v2).toEqual({ kind: 'busy', next: null });
  });
  it('outside hours, no hours, past, and duration too short', () => {
    expect(classifyPoint({ ...day, point: t('2026-10-13T04:00'), busy: [] }).kind).toBe('outside_hours');
    expect(classifyPoint({ ...day, working: [], point: t('2026-10-13T10:00'), busy: [] }).kind).toBe('no_hours');
    expect(classifyPoint({ ...day, now: t('2026-10-13T12:00'), point: t('2026-10-13T10:00'), busy: [] }).kind).toBe('past');
    const v = classifyPoint({ ...day, point: t('2026-10-13T16:30'), busy: [], durationMin: 60 });
    expect(v.kind).toBe('free_short');
    if (v.kind === 'free_short') {
      expect(formatRange(v.window.start, v.window.end, 'en')).toBe('4:30 PM to 5:00 PM');
      expect(v.next).toBeNull();
    }
  });
  it('R1-1: a point at now, within the next five minutes, or seconds old is not busy or past', () => {
    const now = t('2026-10-13T10:03:20');
    const at = (hhmm: string) => classifyPoint({ ...day, now, point: t(`2026-10-13T${hhmm}`), busy: [] });
    for (const hhmm of ['10:03', '10:04', '10:05']) {
      const v = at(hhmm);
      expect(v.kind, hhmm).toBe('free');
      if (v.kind === 'free') expect(formatRange(v.window.start, v.window.end, 'en')).toBe(`${formatTime(t(`2026-10-13T${hhmm}`), 'en')} to 5:00 PM`);
    }
    expect(classifyPoint({ ...day, now: t('2026-10-13T10:00:30'), point: t('2026-10-13T10:00'), busy: [] }).kind).toBe('free');
    expect(classifyPoint({ ...day, now: t('2026-10-13T10:00:30'), point: t('2026-10-13T09:59'), busy: [] }).kind).toBe('past');
  });
});

describe('timezone and formatting', () => {
  it('R1-6/R1-9: normalises overrides, refuses legacy names, labels French cities and odd zones', () => {
    expect(normalizeZoneOverride('EST')).toEqual({ zone: 'America/New_York' });
    expect(normalizeZoneOverride('cet')).toEqual({ zone: 'Europe/Paris' });
    expect(normalizeZoneOverride('Europe/Paris')).toEqual({ zone: 'Europe/Paris' });
    expect(normalizeZoneOverride('UTC')).toEqual({ zone: 'UTC' });
    expect(normalizeZoneOverride('Paris')).toEqual({ invalid: true });
    expect(normalizeZoneOverride('Eastern Time')).toEqual({ invalid: true });
    expect(normalizeZoneOverride('US/Eastern')).toEqual({ invalid: true });
    expect(normalizeZoneOverride('Etc/GMT+2')).toEqual({ invalid: true });
    expect(normalizeZoneOverride(null)).toBeNull();
    expect(normalizeZoneOverride('  ')).toBeNull();
    expect(resolveZone({ override: 'Paris', askerTz: NY, ownerTz: P })).toEqual({ zone: NY, source: 'asker' });
    expect(resolveZone({ override: 'EST', askerTz: P, ownerTz: P })).toEqual({ zone: NY, source: 'override' });
    expect(zoneLabel('Europe/London', 'fr')).toBe('heure de Londres');
    expect(zoneLabel('Asia/Hong_Kong', 'fr')).toBe('heure de Hong Kong');
    expect(zoneLabel('America/Havana', 'fr')).toBe('heure de Havana');
    expect(zoneLabel('America/Argentina/Buenos_Aires', 'en')).toBe('Buenos Aires time');
    expect(zoneLabel('Etc/GMT+2', 'en')).toBe('UTC-2');
    expect(zoneLabel('utc', 'fr')).toBe('UTC');
    expect(formatDate(t('2026-10-01'), 'fr')).toBe('jeudi 1er octobre');
    expect(formatDateLong(t('2026-10-01'), 'fr')).toBe('jeudi 1er octobre');
  });

  it('validates zones, derives labels, resolves the chain', () => {
    expect(isValidZone('America/New_York')).toBe(true);
    expect(isValidZone('Mars/Olympus')).toBe(false);
    expect(zoneLabel('America/New_York', 'en')).toBe('New York time');
    expect(zoneLabel('Europe/Paris', 'fr')).toBe('heure de Paris');
    expect(zoneLabel('Europe/Amsterdam', 'fr')).toBe("heure d'Amsterdam");
    expect(zoneLabel('UTC', 'fr')).toBe('UTC');
    expect(resolveZone({ override: 'Europe/Paris', askerTz: NY, ownerTz: NY })).toEqual({ zone: 'Europe/Paris', source: 'override' });
    expect(resolveZone({ override: 'Nope/Zone', askerTz: NY, ownerTz: P })).toEqual({ zone: NY, source: 'asker' });
    expect(resolveZone({ askerTz: null, ownerTz: P })).toEqual({ zone: P, source: 'owner' });
  });
  it('formats EN and FR', () => {
    const d = t('2026-10-13T16:05', NY);
    expect(formatTime(d, 'en')).toBe('4:05 PM');
    expect(formatTime(t('2026-10-13T12:00', NY), 'en')).toBe('12:00 PM');
    expect(formatTime(t('2026-10-13T00:30', NY), 'en')).toBe('12:30 AM');
    expect(formatTime(d, 'fr')).toBe('16h05');
    expect(formatDate(d, 'en')).toBe('Tue Oct 13');
    expect(formatDate(d, 'fr')).toBe('mardi 13 octobre');
    expect(formatDateLong(d, 'en')).toBe('Tuesday Oct 13');
    expect(formatDuration(60, 'en')).toBe('1 hour');
    expect(formatDuration(90, 'fr')).toBe('1 h 30');
    expect(formatDuration(30, 'en')).toBe('30 min');
  });
});

describe('engine and renderer', () => {
  const ctxEn = { ownerName: 'Alex', lang: 'en' as const, zoneLabel: 'New York time' };
  const ctxFr = { ownerName: 'Alex', lang: 'fr' as const, zoneLabel: 'heure de Paris' };
  const settings = { noiseFloorMin: 15, listingCapDays: 10, openDays: 5 };
  const now = t('2026-10-09T12:00', NY);
  const busyNY = (a: string, b: string) => ({ start: t(a, NY).toUTC().toISO()!, end: t(b, NY).toUTC().toISO()! });

  it('renders the scope point examples byte for byte', async () => {
    const schedule = { ...newYorkAllWeek, availability: [{ days: ['Monday' as const], startTime: '09:00', endTime: '18:00' }] };
    const req: AvailabilityRequest = { kind: 'point', zone: NY, lang: 'en', now, point: t('2026-10-12T16:00', NY) };
    const free = await computeAvailability({ schedule, fetchBusy: async () => [busyNY('2026-10-12T17:30', '2026-10-12T18:00')], settings }, req);
    const r = renderResult(free, req, ctxEn);
    expect(r.text).toBe('Yes, Alex is free Monday Oct 12 from *4:00 PM to 5:30 PM*, 🇺🇸 New York time.');
    // The owner's name is required; Slack markup and any link spelling are refused (R4-4).
    expect(r.required).toContain('Alex');
    expect(verifyReply(r.text, r)).toMatchObject({ ok: true });
    expect(verifyReply(r.text.replace('Alex', 'Marie'), r)).toMatchObject({ ok: false, reason: 'missing_required:Alex' });
    expect(verifyReply(`<!channel> ${r.text}`, r)).toMatchObject({ ok: false, reason: 'markup' });
    expect(verifyReply(`${r.text} <@U123>`, r)).toMatchObject({ ok: false, reason: 'markup' });
    expect(verifyReply(`${r.text} See example.com`, r)).toMatchObject({ ok: false, reason: 'link' });
    expect(verifyReply(`${r.text} Write to mailto:x@y.z`, r)).toMatchObject({ ok: false, reason: 'link' });
    const busy = await computeAvailability({ schedule, fetchBusy: async () => [busyNY('2026-10-12T15:00', '2026-10-12T16:30')], settings }, req);
    expect(renderResult(busy, req, ctxEn).text).toBe('No, Alex is busy Monday Oct 12 at *4:00 PM*. Next free window: *4:30 PM to 6:00 PM*, 🇺🇸 New York time.');
    const early: AvailabilityRequest = { ...req, point: t('2026-10-12T04:00', NY) };
    expect(renderResult(await computeAvailability({ schedule, fetchBusy: async () => [], settings }, early), early, ctxEn).text).toBe("Monday Oct 12 at *4:00 AM* is outside Alex's usual hours, 🇺🇸 New York time.");
    const sat: AvailabilityRequest = { ...req, point: t('2026-10-17T10:00', NY) };
    expect(renderResult(await computeAvailability({ schedule, fetchBusy: async () => [], settings }, sat), sat, ctxEn).text).toBe('Alex does not take meetings on Saturday Oct 17.');
    const past: AvailabilityRequest = { ...req, point: t('2026-10-08T10:00', NY) };
    expect(renderResult(await computeAvailability({ schedule, fetchBusy: async () => [], settings }, past), past, ctxEn).text).toBe('That time is already in the past.');
  });

  it('renders the scope day example in French byte for byte', async () => {
    const schedule = { ...parisOfficeHours, availability: [{ days: ['Tuesday' as const], startTime: '09:00', endTime: '17:00' }] };
    const req: AvailabilityRequest = { kind: 'day', zone: P, lang: 'fr', now: t('2026-10-09T12:00'), rangeStart: t('2026-10-13'), rangeEnd: t('2026-10-14') };
    const busy = (a: string, b: string) => ({ start: t(a).toUTC().toISO()!, end: t(b).toUTC().toISO()! });
    const res = await computeAvailability({ schedule, fetchBusy: async () => [busy('2026-10-13T11:30', '2026-10-13T14:00')], settings }, req);
    expect(renderResult(res, req, ctxFr).text).toBe("*Disponibilités d'Alex mardi 13 octobre*, 🇫🇷 heure de Paris : 9h00–11h30, 14h00–17h00");
  });

  it('renders the scope range example with exclusions, a whole day and an empty day', async () => {
    const schedule = { ...newYorkAllWeek, availability: [{ days: ['Monday' as const, 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '09:00', endTime: '18:00' }] };
    const req: AvailabilityRequest = { kind: 'range', zone: NY, lang: 'en', now, rangeStart: t('2026-10-12', NY), rangeEnd: t('2026-10-17', NY), excludedWeekdays: [3] };
    const fetchBusy = async () => [
      busyNY('2026-10-12T11:30', '2026-10-12T14:00'), busyNY('2026-10-12T17:00', '2026-10-12T18:00'),
      busyNY('2026-10-13T09:00', '2026-10-13T10:00'), busyNY('2026-10-13T12:00', '2026-10-13T18:00'),
      busyNY('2026-10-16T09:00', '2026-10-16T18:00'),
    ];
    const res = await computeAvailability({ schedule, fetchBusy, settings }, req);
    const r = renderResult(res, req, ctxEn);
    expect(r.lines).toEqual([
      "*Alex's availability from Mon Oct 12 to Fri Oct 16 (except Wednesday)*, 🇺🇸 New York time:",
      '• *Mon Oct 12*: 9:00–11:30 AM, 2:00–5:00 PM',
      '• *Tue Oct 13*: 10:00 AM–12:00 PM',
      '• *Thu Oct 15*: ✅ all day, 9:00 AM–6:00 PM',
      '• *Fri Oct 16*: no availability',
    ]);
    expect(r.tokens).toContain('9:00 AM');
    expect(r.tokens).toContain('Thu Oct 15');
    expect(r.required).toEqual(['🇺🇸 New York time', 'Alex', 'Wednesday']);
  });

  it('applies the listing cap, hides empty days on long ranges, and the open range', async () => {
    const schedule = newYorkAllWeek;
    const req: AvailabilityRequest = { kind: 'range', zone: NY, lang: 'en', now, rangeStart: t('2026-10-12', NY), rangeEnd: t('2026-11-02', NY) };
    const res = await computeAvailability({ schedule, fetchBusy: async () => [busyNY('2026-10-13T07:00', '2026-10-13T19:00')], settings }, req);
    expect(res.showEmptyDays).toBe(false);
    expect(res.days.every((d) => d.windows.length > 0)).toBe(true);
    expect(res.days).toHaveLength(10);
    expect(res.truncated).toBe(true);
    expect(renderResult(res, req, ctxEn).lines.at(-1)).toContain('first days shown');
    const open = openRange(schedule, now, NY, 5);
    expect(open.start.toISODate()).toBe('2026-10-09');
    expect(open.end.toISODate()).toBe('2026-10-14');
    const weekdaysOnly = { ...parisOfficeHours };
    const o2 = openRange(weekdaysOnly, t('2026-10-09T12:00'), P, 5); // Friday noon → Fri, Mon..Thu
    expect(o2.end.toISODate()).toBe('2026-10-16');
    const resOpen = await computeAvailability({ schedule, fetchBusy: async () => [], settings }, { kind: 'open', zone: NY, lang: 'en', now });
    expect(resOpen.days).toHaveLength(5);
    expect(renderResult(resOpen, { kind: 'open', zone: NY, lang: 'en', now }, ctxEn).lines[0]).toBe("*Alex's availability over the next 5 working days*, 🇺🇸 New York time:");
  });

  it('R1-3: a whole free day is "all day" in any asker zone', async () => {
    const schedule = { ...newYorkAllWeek, availability: [{ days: ['Tuesday' as const], startTime: '09:00', endTime: '18:00' }] };
    const req: AvailabilityRequest = { kind: 'day', zone: P, lang: 'en', now, rangeStart: t('2026-10-13'), rangeEnd: t('2026-10-14') };
    const res = await computeAvailability({ schedule, fetchBusy: async () => [], settings }, req);
    expect(res.days.map((d) => d.wholeDay)).toEqual([true]);
    expect(renderResult(res, req, { ...ctxEn, zoneLabel: 'Paris time' }).text).toBe("*Alex's availability Tuesday Oct 13*, 🇫🇷 Paris time: ✅ all day, 15:00–00:00"); // Paris: 24-hour clock
  });

  it('R1-4: free but shorter than the duration says so and names the next fitting window', async () => {
    const schedule = { ...newYorkAllWeek, availability: [{ days: ['Tuesday' as const], startTime: '09:00', endTime: '19:00' }] };
    const req: AvailabilityRequest = { kind: 'point', zone: NY, lang: 'en', now, point: t('2026-10-13T16:30', NY), durationMin: 60 };
    const res = await computeAvailability({ schedule, fetchBusy: async () => [busyNY('2026-10-13T17:00', '2026-10-13T17:30')], settings }, req);
    const r = renderResult(res, req, ctxEn);
    expect(r.text).toBe('Alex is free Tuesday Oct 13 at *4:30 PM* but only until *5:00 PM*, 🇺🇸 New York time. Next window of at least 1 hour: *5:30 PM to 7:00 PM*.');
    expect(r.required).toContain('1 hour');
    expect(r.polarity).toBeNull();
    const fr = renderResult(res, { ...req, lang: 'fr' }, { ...ctxFr, zoneLabel: 'heure de New York' });
    expect(fr.text).toBe("Alex est disponible mardi 13 octobre à *16h30* mais seulement jusqu'à *17h00*, 🇺🇸 heure de New York. Prochain créneau d'au moins 1 h : *17h30 à 19h00*.");
    const none = await computeAvailability({ schedule, fetchBusy: async () => [busyNY('2026-10-13T17:00', '2026-10-13T19:00')], settings }, req);
    expect(renderResult(none, req, ctxEn).text).toContain('No later window of at least 1 hour that day.');
    const busyReq = { ...req, point: t('2026-10-13T17:10', NY) };
    expect(renderResult(await computeAvailability({ schedule, fetchBusy: async () => [busyNY('2026-10-13T17:00', '2026-10-13T17:30')], settings }, busyReq), busyReq, ctxEn).text).toBe('No, Alex is busy Tuesday Oct 13 at *5:10 PM*. Next window of at least 1 hour: *5:30 PM to 7:00 PM*, 🇺🇸 New York time.');
  });

  it('R1-8: afternoon runs to the end of the working day', async () => {
    const req: AvailabilityRequest = { kind: 'day', zone: NY, lang: 'en', now, rangeStart: t('2026-10-13', NY), rangeEnd: t('2026-10-14', NY), partOfDay: 'afternoon' };
    const res = await computeAvailability({ schedule: newYorkAllWeek, fetchBusy: async () => [], settings }, req);
    expect(renderResult(res, req, ctxEn).text).toBe("*Alex's availability Tuesday Oct 13 in the afternoon*, 🇺🇸 New York time: 12:00–7:00 PM");
  });

  it('filters by part of day and renders no-availability and duration headers', async () => {
    const schedule = newYorkAllWeek;
    const req: AvailabilityRequest = { kind: 'day', zone: NY, lang: 'fr', now, rangeStart: t('2026-10-13', NY), rangeEnd: t('2026-10-14', NY), partOfDay: 'morning', durationMin: 60 };
    const res = await computeAvailability({ schedule, fetchBusy: async () => [busyNY('2026-10-13T07:00', '2026-10-13T11:30')], settings }, req);
    expect(renderResult(res, req, { ...ctxFr, zoneLabel: 'heure de New York' }).text).toBe("Alex n'a aucune disponibilité mardi 13 octobre le matin, créneaux d'au moins 1 h, 🇺🇸 heure de New York.");
    const res2 = await computeAvailability({ schedule, fetchBusy: async () => [busyNY('2026-10-13T07:00', '2026-10-13T10:30')], settings }, req);
    const r2 = renderResult(res2, req, { ...ctxFr, zoneLabel: 'heure de New York' });
    expect(r2.lines).toEqual(["*Disponibilités d'Alex mardi 13 octobre le matin*, créneaux d'au moins 1 h, 🇺🇸 heure de New York : 10h30–12h00"]);
    expect(r2.required).toEqual(['🇺🇸 heure de New York', 'Alex', 'le matin', '1 h']);
  });
});

describe('1.1.0: flags and clock style', () => {
  it('maps every zone of the table to a flag and a clock; globe and 24-hour otherwise', () => {
    expect(ZONE_COUNTRIES.size).toBeGreaterThan(400);
    for (const [zone, cc] of ZONE_COUNTRIES) {
      expect(isValidZone(zone), zone).toBe(true);
      expect(cc, zone).toMatch(/^[A-Z]{2}$/);
    }
    expect(zoneFlag('Europe/Paris')).toBe('🇫🇷');
    expect(zoneFlag('America/New_York')).toBe('🇺🇸');
    expect(zoneFlag('Europe/Amsterdam')).toBe('🇳🇱');
    expect(zoneFlag('Asia/Kolkata')).toBe('🇮🇳');
    expect(zoneFlag('Asia/Calcutta')).toBe('🇮🇳');
    expect(zoneFlag('UTC')).toBe('🌐');
    expect(zoneFlag('Etc/GMT+2')).toBe('🌐');
    expect(zoneFlag('US/Pacific')).toBe('🌍'); // valid for luxon, absent from the table
    expect(clockStyle('Europe/Paris')).toBe('24h');
    expect(clockStyle('Europe/London')).toBe('24h');
    expect(clockStyle('America/New_York')).toBe('12h');
    expect(clockStyle('Australia/Sydney')).toBe('12h');
    expect(clockStyle('Asia/Kolkata')).toBe('12h');
    expect(clockStyle('UTC')).toBe('24h');
    expect(clockStyle('US/Pacific')).toBe('24h');
    expect(formatTime(t('2026-10-13T16:05'), 'en', '24h')).toBe('16:05');
    expect(formatTime(t('2026-10-13T00:00'), 'en', '24h')).toBe('00:00');
    expect(formatTime(t('2026-10-13T16:05'), 'fr', '24h')).toBe('16h05');
    expect(formatRange(t('2026-10-13T09:00'), t('2026-10-13T12:00'), 'en', '24h')).toBe('09:00 to 12:00');
  });

  it('1.2.0: the compact span shares AM/PM when both ends agree', () => {
    expect(formatSpan(t('2026-10-13T09:00', NY), t('2026-10-13T11:30', NY), 'en')).toBe('9:00–11:30 AM');
    expect(formatSpan(t('2026-10-13T10:00', NY), t('2026-10-13T12:00', NY), 'en')).toBe('10:00 AM–12:00 PM');
    expect(formatSpan(t('2026-10-13T19:00', NY), t('2026-10-14T01:00', NY), 'en')).toBe('7:00 PM–1:00 AM');
    expect(formatSpan(t('2026-10-13T13:00'), t('2026-10-14T01:00'), 'en', '24h')).toBe('13:00–01:00');
    expect(formatSpan(t('2026-10-13T13:00'), t('2026-10-14T01:00'), 'fr')).toBe('13h00–1h00');
  });
});

describe('1.2.0: compact listings, no split at midnight, slots', () => {
  const ctxEn = { ownerName: 'Alex', lang: 'en' as const, zoneLabel: 'New York time' };
  const ctxParis = { ...ctxEn, zoneLabel: 'Paris time' };
  const ctxFr = { ownerName: 'Alex', lang: 'fr' as const, zoneLabel: 'heure de Paris' };
  const settings = { noiseFloorMin: 15, listingCapDays: 10, openDays: 5 };
  const now = t('2026-10-09T12:00', NY);
  // From Nov 2 both zones are on standard time: 7 AM–7 PM New York is 13:00–01:00 Paris.
  const nowNov = t('2026-10-30T12:00', NY);
  const horizonEnd = t('2026-11-28');
  const busyNY = (a: string, b: string) => ({ start: t(a, NY).toUTC().toISO()!, end: t(b, NY).toUTC().toISO()! });
  const run = (busy: ReturnType<typeof busyNY>[], req: AvailabilityRequest, schedule = newYorkAllWeek) => computeAvailability({ schedule, fetchBusy: async () => busy, settings }, req);

  it('lists a single day on one line, in the compact form, without part-of-day labels', async () => {
    const req: AvailabilityRequest = { kind: 'day', zone: NY, lang: 'en', now, rangeStart: t('2026-10-13', NY), rangeEnd: t('2026-10-14', NY) };
    const r = renderResult(await run([busyNY('2026-10-13T09:00', '2026-10-13T13:00'), busyNY('2026-10-13T17:00', '2026-10-13T18:00')], req), req, ctxEn);
    expect(r.text).toBe("*Alex's availability Tuesday Oct 13*, 🇺🇸 New York time: 7:00–9:00 AM, 1:00–5:00 PM, 6:00–7:00 PM");
    expect(r.lines).toHaveLength(1);
    expect(r.timeSequence).toEqual(['7:00 AM', '9:00 AM', '1:00 PM', '5:00 PM', '6:00 PM', '7:00 PM']);
    expect(r.required[0]).toBe('🇺🇸 New York time');
  });

  it('shows a European asker the 24-hour clock, also in the week when Europe has left summer time and the US has not', async () => {
    // Tue 2026-10-27: Paris is UTC+1 since Oct 25, New York UTC-4 until Nov 1, so 7:00 AM New York is 12:00 Paris.
    const busy = [busyNY('2026-10-27T09:00', '2026-10-27T13:00'), busyNY('2026-10-27T17:00', '2026-10-27T18:00')];
    const paris: AvailabilityRequest = { kind: 'day', zone: P, lang: 'en', now, rangeStart: t('2026-10-27'), rangeEnd: t('2026-10-28') };
    expect(renderResult(await run(busy, paris), paris, ctxParis).text).toBe("*Alex's availability Tuesday Oct 27*, 🇫🇷 Paris time: 12:00–14:00, 18:00–22:00, 23:00–00:00");
    const ny: AvailabilityRequest = { ...paris, zone: NY, rangeStart: t('2026-10-27', NY), rangeEnd: t('2026-10-28', NY) };
    expect(renderResult(await run(busy, ny), ny, ctxEn).text).toBe("*Alex's availability Tuesday Oct 27*, 🇺🇸 New York time: 7:00–9:00 AM, 1:00–5:00 PM, 6:00–7:00 PM");
  });

  it('keeps a window that crosses midnight whole, on the day it starts', async () => {
    const busy = [busyNY('2026-11-02T10:00', '2026-11-02T10:30'), busyNY('2026-11-02T12:30', '2026-11-02T13:00'), busyNY('2026-11-03T18:30', '2026-11-03T19:00')];
    const week: AvailabilityRequest = { kind: 'range', zone: P, lang: 'en', now: nowNov, rangeStart: t('2026-11-02'), rangeEnd: t('2026-11-05') };
    const res = await run(busy, week);
    const r = renderResult(res, week, ctxParis);
    expect(r.lines).toEqual([
      "*Alex's availability from Mon Nov 2 to Wed Nov 4*, 🇫🇷 Paris time:",
      '• *Mon Nov 2*: 13:00–16:00, 16:30–18:30, 19:00–01:00',
      '• *Tue Nov 3*: 13:00–00:30',
      '• *Wed Nov 4*: ✅ all day, 13:00–01:00',
    ]);
    // The tail of the previous evening never shows as "00:00–01:00" on the next day, and a whole free day is still detected (R1-3).
    expect(r.text).not.toContain('00:00–01:00');
    expect(res.days.map((d) => d.wholeDay)).toEqual([false, false, true]);
    const sat: AvailabilityRequest = { kind: 'day', zone: P, lang: 'en', now: nowNov, rangeStart: t('2026-11-07'), rangeEnd: t('2026-11-08') };
    expect(renderResult(await run([], sat), sat, ctxParis).text).toBe("*Alex's availability Saturday Nov 7*, 🇫🇷 Paris time: ✅ all day, 13:00–01:00");
    // Afternoon and evening have no end: the window is not cut at midnight either.
    const evening: AvailabilityRequest = { kind: 'day', zone: P, lang: 'en', now: nowNov, rangeStart: t('2026-11-02'), rangeEnd: t('2026-11-03'), partOfDay: 'evening' };
    expect(renderResult(await run([], evening), evening, ctxParis).text).toBe("*Alex's availability Monday Nov 2 in the evening*, 🇫🇷 Paris time: 18:00–01:00");
  });

  it('keeps a free hour at 00:00 after a late block on the working day it belongs to (seen live 2026-10-30)', async () => {
    // Thursday Nov 5 (New York): busy 11:00–12:00, 13:00–16:00, 16:30–18:00; the last free hour 18:00–19:00 is 00:00–01:00 Friday in Paris.
    const busy = [busyNY('2026-11-05T11:00', '2026-11-05T12:00'), busyNY('2026-11-05T13:00', '2026-11-05T16:00'), busyNY('2026-11-05T16:30', '2026-11-05T18:00')];
    const req: AvailabilityRequest = { kind: 'range', zone: P, lang: 'en', now: nowNov, rangeStart: t('2026-11-05'), rangeEnd: t('2026-11-07') };
    expect(renderResult(await run(busy, req), req, ctxParis).lines).toEqual([
      "*Alex's availability from Thu Nov 5 to Fri Nov 6*, 🇫🇷 Paris time:",
      '• *Thu Nov 5*: 13:00–17:00, 18:00–19:00, 22:00–22:30, 00:00–01:00',
      '• *Fri Nov 6*: ✅ all day, 13:00–01:00',
    ]);
    // "Thursday evening" includes that hour; "Friday morning" does not.
    const thuEvening: AvailabilityRequest = { ...req, kind: 'day', rangeEnd: t('2026-11-06'), partOfDay: 'evening' };
    expect(renderResult(await run(busy, thuEvening), thuEvening, ctxParis).text).toBe("*Alex's availability Thursday Nov 5 in the evening*, 🇫🇷 Paris time: 18:00–19:00, 22:00–22:30, 00:00–01:00");
    const friMorning: AvailabilityRequest = { ...req, kind: 'day', rangeStart: t('2026-11-06'), partOfDay: 'morning' };
    expect(renderResult(await run(busy, friMorning), friMorning, ctxParis).text).toBe("Alex has no availability Friday Nov 6 in the morning, 🇫🇷 Paris time.");
  });

  it('"today" asked after midnight keeps what is still available from the running working day', async () => {
    const now = t('2026-11-03T00:20'); // Paris; the New York Monday runs until 01:00
    const req: AvailabilityRequest = { kind: 'day', zone: P, lang: 'en', now, rangeStart: t('2026-11-03'), rangeEnd: t('2026-11-04') };
    expect(renderResult(await run([], req), req, ctxParis).text).toBe("*Alex's availability Tuesday Nov 3*, 🇫🇷 Paris time: 00:20–01:00, 13:00–01:00");
    // Asked "tomorrow" at the same moment, the running tail is not tomorrow's.
    const tomorrow: AvailabilityRequest = { ...req, rangeStart: t('2026-11-04'), rangeEnd: t('2026-11-05') };
    expect(renderResult(await run([], tomorrow), tomorrow, ctxParis).text).toBe("*Alex's availability Wednesday Nov 4*, 🇫🇷 Paris time: ✅ all day, 13:00–01:00");
  });

  it('answers a point with the real end of a window crossing midnight, and one after midnight from the running day', async () => {
    const late: AvailabilityRequest = { kind: 'point', zone: P, lang: 'en', now: nowNov, point: t('2026-11-02T23:00') };
    expect(renderResult(await run([], late), late, ctxParis).text).toBe('Yes, Alex is free Monday Nov 2 from *23:00 to 01:00*, 🇫🇷 Paris time.');
    const early: AvailabilityRequest = { kind: 'point', zone: P, lang: 'en', now: nowNov, point: t('2026-11-03T00:30') };
    expect(renderResult(await run([], early), early, ctxParis).text).toBe('Yes, Alex is free Tuesday Nov 3 from *00:30 to 01:00*, 🇫🇷 Paris time.');
    // "Next" stays on the asked day: the window starting at 13:00 the next day is not offered.
    const busyLate: AvailabilityRequest = { kind: 'point', zone: P, lang: 'en', now: nowNov, point: t('2026-11-02T23:30') };
    expect(renderResult(await run([busyNY('2026-11-02T17:00', '2026-11-02T19:00')], busyLate), busyLate, ctxParis).text).toBe('No, Alex is busy Monday Nov 2 at *23:30*. No other availability that day, 🇫🇷 Paris time.');
  });

  it('classifies a span: free, partly, busy with the next window, past, started, outside hours, no hours, duration', () => {
    const working = [iv('2026-10-13T09:00', '2026-10-13T17:00')];
    const day = { dayStart: t('2026-10-13T00:00'), dayEnd: t('2026-10-14T00:00'), now: t('2026-10-12T12:00'), noiseFloorMin: 15, working };
    const span = iv('2026-10-13T10:00', '2026-10-13T12:00');
    const fmt = (w: { start: DateTime; end: DateTime }) => formatRange(w.start, w.end, 'fr');
    const free = classifySpan({ ...day, span, busy: [] });
    expect(free.kind).toBe('free');
    if (free.kind === 'free') expect(fmt(free.window)).toBe('10h00 à 12h00');
    const partly = classifySpan({ ...day, span, busy: [iv('2026-10-13T10:30', '2026-10-13T11:00')] });
    expect(partly.kind).toBe('partly');
    if (partly.kind === 'partly') expect(partly.windows.map(fmt)).toEqual(['10h00 à 10h30', '11h00 à 12h00']);
    // A free part under the noise floor does not count: the span is busy and the next window of the day is named.
    const sliver = classifySpan({ ...day, span, busy: [iv('2026-10-13T10:00', '2026-10-13T11:50')] });
    expect(sliver.kind).toBe('busy');
    if (sliver.kind === 'busy') expect(fmt(sliver.next!)).toBe('12h00 à 17h00');
    const busy = classifySpan({ ...day, span, busy: [iv('2026-10-13T09:00', '2026-10-13T13:00')] });
    expect(busy.kind).toBe('busy');
    if (busy.kind === 'busy') expect(fmt(busy.next!)).toBe('13h00 à 17h00');
    expect(classifySpan({ ...day, span, busy: [], now: t('2026-10-13T12:30') }).kind).toBe('past');
    const started = classifySpan({ ...day, span, busy: [], now: t('2026-10-13T10:31') });
    expect(started.kind).toBe('free');
    if (started.kind === 'free') expect(fmt(started.window)).toBe('10h35 à 12h00');
    expect(classifySpan({ ...day, span: iv('2026-10-13T06:00', '2026-10-13T08:00'), busy: [] }).kind).toBe('outside_hours');
    expect(classifySpan({ ...day, span, busy: [], working: [] }).kind).toBe('no_hours');
    const dur = classifySpan({ ...day, span, busy: [iv('2026-10-13T10:30', '2026-10-13T11:00')], durationMin: 60 });
    expect(dur.kind).toBe('partly');
    if (dur.kind === 'partly') expect(dur.windows.map(fmt)).toEqual(['11h00 à 12h00']);
  });

  it('renders one verdict per asked slot, in the order asked, in English and in French', async () => {
    // Busy (New York): Tue Nov 3 9:00–11:30 = 15:00–17:30 Paris; Wed Nov 4 8:00–8:30 = 14:00–14:30 Paris; Thu Nov 5 all day.
    const busy = [busyNY('2026-11-03T09:00', '2026-11-03T11:30'), busyNY('2026-11-04T08:00', '2026-11-04T08:30'), busyNY('2026-11-05T07:00', '2026-11-05T19:00')];
    const en: AvailabilityRequest = {
      kind: 'slots', zone: P, lang: 'en', now: nowNov, horizonEnd,
      slots: [
        { start: t('2026-11-03T16:00') }, { start: t('2026-11-04T11:30') }, { start: t('2026-11-04T13:30') }, { start: t('2026-11-05T14:00') },
        { start: t('2026-10-29T10:00') }, { start: t('2026-12-01T10:00') },
        { start: t('2026-11-04T13:00'), end: t('2026-11-04T15:00') }, { start: t('2026-11-04T17:00'), end: t('2026-11-04T18:00') }, { start: t('2026-11-05T13:00'), end: t('2026-11-05T15:00') },
      ],
    };
    const r = renderResult(await run(busy, en), en, { ...ctxParis, horizonWeeks: 4 });
    expect(r.lines).toEqual([
      "*Alex's availability*, 🇫🇷 Paris time:",
      '• *Tue Nov 3, 16:00*: ❌ busy, next free 17:30–01:00',
      "• *Wed Nov 4, 11:30*: outside Alex's usual hours",
      '• *Wed Nov 4, 13:30*: ✅ free until 14:00',
      '• *Thu Nov 5, 14:00*: ❌ busy',
      '• *Thu Oct 29, 10:00*: already past',
      '• *Tue Dec 1, 10:00*: more than 4 weeks ahead',
      '• *Wed Nov 4, 13:00–15:00*: ⚠️ partly free: 13:00–14:00, 14:30–15:00',
      '• *Wed Nov 4, 17:00–18:00*: ✅ free',
      '• *Thu Nov 5, 13:00–15:00*: ❌ busy',
    ]);
    expect(r.required).toEqual(['🇫🇷 Paris time', 'Alex']);
    expect(r.polarity).toBeNull();
    const fr: AvailabilityRequest = { ...en, lang: 'fr', slots: en.slots!.slice(0, 3).concat(en.slots![6]!, en.slots![3]!) };
    expect(renderResult(await run(busy, fr), fr, ctxFr).lines).toEqual([
      "*Disponibilités d'Alex*, 🇫🇷 heure de Paris :",
      '• *mardi 3 novembre, 16h00* : ❌ pas disponible, prochain créneau 17h30–1h00',
      "• *mercredi 4 novembre, 11h30* : en dehors des heures habituelles d'Alex",
      "• *mercredi 4 novembre, 13h30* : ✅ disponible jusqu'à 14h00",
      '• *mercredi 4 novembre, 13h00–15h00* : ⚠️ en partie : 13h00–14h00, 14h30–15h00',
      '• *jeudi 5 novembre, 14h00* : ❌ pas disponible',
    ]);
  });

  it('renders slot verdicts with a duration, a day without hours and busy spans', async () => {
    const busy = [busyNY('2026-11-03T09:00', '2026-11-03T11:30'), busyNY('2026-11-04T08:00', '2026-11-04T08:30'), busyNY('2026-11-05T07:00', '2026-11-05T19:00')];
    const dur: AvailabilityRequest = { kind: 'slots', zone: NY, lang: 'en', now: nowNov, horizonEnd, durationMin: 60, slots: [{ start: t('2026-11-04T07:00', NY) }, { start: t('2026-11-03T08:30', NY) }, { start: t('2026-11-05T10:00', NY) }] };
    const r = renderResult(await run(busy, dur), dur, ctxEn);
    expect(r.lines).toEqual([
      "*Alex's availability*, windows of at least 1 hour, 🇺🇸 New York time:",
      '• *Wed Nov 4, 7:00 AM*: ✅ free until 8:00 AM',
      '• *Tue Nov 3, 8:30 AM*: ⚠️ free only until 9:00 AM; next window of at least 1 hour: 11:30 AM–7:00 PM',
      '• *Thu Nov 5, 10:00 AM*: ❌ busy',
    ]);
    expect(r.required).toEqual(['🇺🇸 New York time', 'Alex', '1 hour']);
    const weekdays = { ...newYorkAllWeek, availability: [{ days: ['Monday' as const, 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '09:00', endTime: '18:00' }] };
    const spans: AvailabilityRequest = { kind: 'slots', zone: NY, lang: 'en', now: nowNov, horizonEnd, slots: [{ start: t('2026-11-07T10:00', NY) }, { start: t('2026-11-03T12:00', NY), end: t('2026-11-03T16:00', NY) }, { start: t('2026-11-03T16:00', NY), end: t('2026-11-03T18:00', NY) }] };
    expect(renderResult(await run([busyNY('2026-11-03T12:00', '2026-11-03T16:00')], spans, weekdays), spans, ctxEn).lines).toEqual([
      "*Alex's availability*, 🇺🇸 New York time:",
      '• *Sat Nov 7, 10:00 AM*: does not take meetings that day',
      '• *Tue Nov 3, 12:00–4:00 PM*: ❌ busy, next free 4:00–6:00 PM',
      '• *Tue Nov 3, 4:00–6:00 PM*: ✅ free',
    ]);
  });

  it('skips the busy lookup when no slot needs one', async () => {
    let fetched = 0;
    const req: AvailabilityRequest = { kind: 'slots', zone: NY, lang: 'en', now: nowNov, horizonEnd, slots: [{ start: t('2026-10-29T10:00', NY) }, { start: t('2026-12-01T10:00', NY) }] };
    const res = await computeAvailability({ schedule: newYorkAllWeek, fetchBusy: async () => (fetched++, []), settings }, req);
    expect(fetched).toBe(0);
    expect(res.slots!.map((s) => s.verdict.kind)).toEqual(['past', 'beyond_horizon']);
  });
});
