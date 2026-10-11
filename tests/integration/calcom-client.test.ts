import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED_PATHS, CalcomClient, CalcomError } from '../../src/calcom/client.js';
import { Secret } from '../../src/crypto/secret.js';

interface Hit {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let base: string;
const hits: Hit[] = [];
let mode: 'ok' | 'flaky429' | 'fail500' | 'unauthorized' | 'garbage' = 'ok';
let flakyLeft = 0;

const CALENDARS = {
  status: 'success',
  data: {
    connectedCalendars: [
      {
        integration: { name: 'Google Calendar', slug: 'google-calendar', type: 'google_calendar' },
        credentialId: 10,
        calendars: [
          { externalId: 'a@x.com', name: 'a@x.com', primary: true, readOnly: false, email: 'a@x.com', isSelected: true, credentialId: 10 },
          { externalId: 'shared@y.com', name: 'shared', primary: false, readOnly: true, email: 'shared@y.com', isSelected: false, credentialId: 10 },
        ],
      },
      { integration: { name: 'Google Calendar', slug: 'google-calendar' }, credentialId: 11, calendars: [{ externalId: 'b@z.com', readOnly: false, isSelected: true, credentialId: 11 }] },
    ],
    destinationCalendar: { id: 1, integration: 'google_calendar', externalId: 'a@x.com', primaryEmail: null, userId: 1, eventTypeId: null, credentialId: 10 },
  },
};
const SCHEDULE = { status: 'success', data: { id: 5, ownerId: 1, name: 'Working Hours', timeZone: 'America/New_York', availability: [{ days: ['Monday', 'Tuesday'], startTime: '07:00', endTime: '19:00' }], isDefault: true, overrides: [] } };
const BUSY = { status: 'success', data: [{ start: '2026-10-10T13:00:00.000Z', end: '2026-10-10T13:30:00.000Z', source: 'google_calendar' }] };

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  hits.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers });
  const send = (code: number, body: unknown, raw = false) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(raw ? String(body) : JSON.stringify(body));
  };
  if (mode === 'unauthorized') return send(401, { status: 'error' });
  if (mode === 'fail500') return send(500, { status: 'error' });
  if (mode === 'garbage') return send(200, '<html>', true);
  if (mode === 'flaky429' && flakyLeft > 0) {
    flakyLeft--;
    return send(429, { status: 'error' });
  }
  if (url.pathname === '/v2/me') return send(200, { status: 'success', data: { username: 'alex', timeZone: 'America/New_York', email: 'hidden@x.com' } });
  if (url.pathname === '/v2/calendars') return send(200, CALENDARS);
  if (url.pathname === '/v2/schedules/default') return send(200, SCHEDULE);
  if (url.pathname === '/v2/calendars/busy-times') return send(200, BUSY);
  return send(404, { status: 'error' });
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  hits.length = 0;
  mode = 'ok';
});

const client = () => new CalcomClient({ apiKey: () => new Secret('cal_live_test'), baseUrl: base, retries: 2, sleep: async () => {} });

describe('CalcomClient', () => {
  it('sends GET with both headers and only allowlisted paths', async () => {
    const c = client();
    await c.me();
    await c.calendars();
    await c.defaultSchedule();
    await c.busyTimes({ dateFrom: '2026-10-10', dateTo: '2026-10-11', timeZone: 'America/New_York', calendars: [{ credentialId: 10, externalId: 'a@x.com' }, { credentialId: 11, externalId: 'b,c@z.com' }] });
    expect(hits.every((h) => h.method === 'GET')).toBe(true);
    expect(hits.map((h) => h.path.split('?')[0])).toEqual(['/v2/me', '/v2/calendars', '/v2/schedules/default', '/v2/calendars/busy-times']);
    expect(hits.every((h) => h.headers.authorization === 'Bearer cal_live_test')).toBe(true);
    expect(hits[0]!.headers['cal-api-version']).toBe('2024-08-13');
    expect(hits[2]!.headers['cal-api-version']).toBe('2024-06-11');
    const q = new URL('http://x' + hits[3]!.path).searchParams;
    expect(q.getAll('calendar')).toEqual(['10,a@x.com', '11,b,c@z.com']);
    expect(q.get('dateFrom')).toBe('2026-10-10');
    expect(q.get('timeZone')).toBe('America/New_York');
    expect(new Set(Object.values(ALLOWED_PATHS)).size).toBe(4);
  });

  it('parses calendars with the selected flag and drops the busy source', async () => {
    const c = client();
    const cals = await c.calendars();
    expect(cals.map((x) => [x.credentialId, x.externalId, x.isSelected])).toEqual([[10, 'a@x.com', true], [10, 'shared@y.com', false], [11, 'b@z.com', true]]);
    const busy = await c.busyTimes({ dateFrom: '2026-10-10', dateTo: '2026-10-10', timeZone: 'UTC', calendars: [{ credentialId: 10, externalId: 'a@x.com' }] });
    expect(busy).toEqual([{ start: '2026-10-10T13:00:00.000Z', end: '2026-10-10T13:30:00.000Z' }]);
    expect(JSON.stringify(busy)).not.toContain('source');
    const me = await c.me();
    expect(JSON.stringify(me)).not.toContain('hidden@x.com');
    expect(await c.busyTimes({ dateFrom: '2026-10-10', dateTo: '2026-10-10', timeZone: 'UTC', calendars: [] })).toEqual([]);
    expect(hits.map((h) => h.path.split('?')[0])).not.toContain('/v2/calendars/busy-times?');
  });

  it('retries on 429 then succeeds, surfaces 5xx, 401 and garbage', async () => {
    mode = 'flaky429';
    flakyLeft = 2;
    expect((await client().me()).username).toBe('alex');
    expect(hits).toHaveLength(3);
    mode = 'fail500';
    await expect(client().me()).rejects.toMatchObject({ kind: 'unavailable' });
    mode = 'unauthorized';
    await expect(client().me()).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
    mode = 'garbage';
    await expect(client().me()).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('refuses to run without a key and never reaches the network', async () => {
    const c = new CalcomClient({ apiKey: () => null, baseUrl: base });
    await expect(c.me()).rejects.toBeInstanceOf(CalcomError);
    expect(hits).toHaveLength(0);
  });
});
