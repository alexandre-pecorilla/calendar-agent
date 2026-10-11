import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { computeAvailability } from '../../src/availability/engine.js';
import { formatRange } from '../../src/availability/format.js';
import { renderResult } from '../../src/availability/render.js';
import { CalcomClient } from '../../src/calcom/client.js';
import { Secret } from '../../src/crypto/secret.js';
import { appendFileSync, mkdirSync } from 'node:fs';

const LOG = process.env.LIVE_LOG ?? 'docs/testing/evidence/live-calcom.txt';
mkdirSync('docs/testing/evidence', { recursive: true });
function out(line: string): void {
  appendFileSync(LOG, line + '\n');
}

/**
 * Live, read-only. Requires CALCOM_API_KEY. Evaluates the owner's free/busy
 * test matrix (action plan Appendix C; the owner used 2026-10-10 and 2026-10-11
 * on owner@example.com). "now" is injected before the matrix date so the
 * result does not depend on when this runs.
 */
const key = process.env.CALCOM_API_KEY?.trim();
const MATRIX_DATE = process.env.MATRIX_DATE ?? '2026-10-10';
const BUSY_ALL_DAY_DATE = process.env.MATRIX_BUSY_DAY ?? '2026-10-11';

describe.skipIf(!key)('Cal.com live', () => {
  const client = new CalcomClient({ apiKey: () => new Secret(key!) });

  it('authenticates and lists selected calendars and the schedule', async () => {
    const me = await client.me();
    expect(me.username).toBeTruthy();
    const cals = await client.calendars();
    const selected = cals.filter((c) => c.isSelected);
    expect(selected.length).toBeGreaterThan(0);
    const s = await client.defaultSchedule();
    expect(s).not.toBeNull();
    out(`[live] me=${me.username} tz=${s!.timeZone} selected=${selected.length} rules=${s!.availability.length} overrides=${s!.overrides.length}`);
    for (const c of selected) out(`[live]   selected cred=${c.credentialId} ${c.externalId}`);
  });

  it('evaluates the free/busy matrix', async () => {
    const s = (await client.defaultSchedule())!;
    const zone = s.timeZone;
    const selected = (await client.calendars()).filter((c) => c.isSelected);
    const calendars = selected.map((c) => ({ credentialId: c.credentialId, externalId: c.externalId }));
    // Cal.com clips at dateTo (an all-day block on dateTo came back cut at 10:00 local); the engine
    // widens the request by a day on each side, so the live test fetches through the same path.
    const fetchBusy = (dateFrom: string, dateTo: string, timeZone: string) => client.busyTimes({ dateFrom, dateTo, timeZone, calendars });
    const busy = await client.busyTimes({ dateFrom: MATRIX_DATE, dateTo: DateTime.fromISO(BUSY_ALL_DAY_DATE).plus({ days: 1 }).toISODate()!, timeZone: zone, calendars });
    out(`[live] busy intervals ${MATRIX_DATE}..${BUSY_ALL_DAY_DATE}+1 (${zone}):`);
    for (const b of busy) {
      const a = DateTime.fromISO(b.start).setZone(zone);
      const e = DateTime.fromISO(b.end).setZone(zone);
      out(`[live]   ${a.toFormat('yyyy-MM-dd HH:mm')} → ${e.toFormat('yyyy-MM-dd HH:mm')}`);
    }
    const now = DateTime.fromISO(`${MATRIX_DATE}T00:00`, { zone }).minus({ hours: 12 });
    const rows: Array<[string, string]> = [
      ['09:00', 'busy (accepted)'], ['10:00', 'busy (maybe)'], ['11:00', 'busy (unanswered)'],
      ['13:00', 'free (declined)'], ['14:00', 'free (show as free)'], ['15:00', 'busy (own event)'],
      ['16:00', 'busy (accepted+declined overlap, optional)'], ['17:00', 'free (free+declined overlap, optional)'],
    ];
    const deps = { schedule: s, fetchBusy, settings: { noiseFloorMin: 15, listingCapDays: 10, openDays: 5 } };
    out(`[live] matrix ${MATRIX_DATE} (${zone}):`);
    for (const [hhmm, expected] of rows) {
      const point = DateTime.fromISO(`${MATRIX_DATE}T${hhmm}`, { zone }).plus({ minutes: 5 });
      const req = { kind: 'point' as const, zone, lang: 'en' as const, now, point };
      const res = await computeAvailability(deps, req);
      const v = res.verdict!;
      const observed = v.kind === 'free' ? 'free' : v.kind === 'busy' ? 'busy' : v.kind;
      const detail = v.kind === 'free' ? formatRange(v.window.start, v.window.end, 'en') : v.kind === 'busy' && v.next ? `next ${formatRange(v.next.start, v.next.end, 'en')}` : '';
      out(`[live]   ${hhmm}  expected ${expected.padEnd(44)} observed ${observed.padEnd(6)} ${detail}`);
    }
    const dayReq = { kind: 'day' as const, zone, lang: 'en' as const, now, rangeStart: DateTime.fromISO(MATRIX_DATE, { zone }), rangeEnd: DateTime.fromISO(MATRIX_DATE, { zone }).plus({ days: 1 }) };
    const dayRes = await computeAvailability(deps, dayReq);
    out('[live] day listing:\n' + renderResult(dayRes, dayReq, { ownerName: 'Owner', lang: 'en', zoneLabel: zone }).text.split('\n').map((l) => '[live]   ' + l).join('\n'));
    const nextReq = { ...dayReq, rangeStart: DateTime.fromISO(BUSY_ALL_DAY_DATE, { zone }), rangeEnd: DateTime.fromISO(BUSY_ALL_DAY_DATE, { zone }).plus({ days: 1 }) };
    const nextRes = await computeAvailability(deps, nextReq);
    out(`[live] ${BUSY_ALL_DAY_DATE} (all-day busy expected): ${nextRes.days.some((d) => d.windows.length) ? 'HAS availability' : 'no availability'}`);
    expect(busy.length).toBeGreaterThan(0);
  });
});
