import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { createAdminServer } from '../../src/admin/server.js';
import { createStatus, type RuntimeStatus } from '../../src/admin/status.js';
import { loadConfig } from '../../src/config/env.js';
import { encrypt, parseMasterKey } from '../../src/crypto/envelope.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { createLogger } from '../../src/logging/logger.js';
import type { Services } from '../../src/services/pipeline-factory.js';
import type { AskContext } from '../../src/pipeline/answer.js';
import { Writable } from 'node:stream';

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString('base64');
const ADMIN_PW = 'correct-horse-battery-staple';

let app: FastifyInstance;
let repos: Repositories;
let status: RuntimeStatus;
const asked: AskContext[] = [];
let calcomUp = true;

const fakeServices = {
  calcom: {
    me: async () => { if (!calcomUp) throw new Error('down'); return { username: 'alex', timeZone: 'America/New_York' }; },
    calendars: async () => [{ credentialId: 1, externalId: 'a@x.com', name: null, email: null, integration: null, isSelected: true, readOnly: false, primary: true }],
    defaultSchedule: async () => ({ id: 1, name: 'W', timeZone: 'America/New_York', availability: [{ days: ['Monday'], startTime: '09:00', endTime: '17:00' }], isDefault: true, overrides: [] }),
  },
  calcomCache: {
    calendars: async () => [{ credentialId: 1, externalId: 'a@x.com', name: null, email: null, integration: null, isSelected: true, readOnly: false, primary: true }],
    selectedCalendars: async () => [],
    defaultSchedule: async () => ({ id: 1, name: 'W', timeZone: 'America/New_York', availability: [{ days: ['Monday'], startTime: '09:00', endTime: '17:00' }], isDefault: true, overrides: [] }),
    invalidate: () => {},
  },
  deepseek: { complete: async () => ({ content: 'OK', usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, reasoningTokens: 0, costUsd: 0.000001 }, latencyMs: 5, retried: false }) },
  pipeline: {
    ask: async (ctx: AskContext, text: string) => {
      asked.push(ctx);
      const id = repos.queries.insert({ workspace_id: null, workspace_name: null, user_id: ctx.userId, user_name: ctx.userName ?? null, entry_point: ctx.entryPoint, channel_id: null, question: text, intent: 'day', parsed_json: '{"intent":"day"}', answer: 'Alex is free Monday Oct 12, New York time:\n• 9:00 AM to 5:00 PM', language: 'en', timezone_used: ctx.askerTz ?? null, latency_ms: 10, prompt_tokens: 1, completion_tokens: 1, cost_usd: 0.000001, error: null });
      return { text: 'Alex is free Monday Oct 12, New York time:\n• 9:00 AM to 5:00 PM', intent: 'day', language: 'en' as const, queryId: id, debug: { question: text, truncated: false, parsed: { intent: 'day' }, parseRaw: '{}', zone: ctx.askerTz ?? 'UTC', zoneSource: 'asker' as const, zoneLabel: 'New York time', language: 'en' as const, busyCount: 2, windows: ['2026-10-12 9:00 AM to 5:00 PM'], draft: 'draft', phrased: true, verification: 'ok', latencyMs: 10, promptTokens: 1, completionTokens: 1, reasoningTokens: 0, costUsd: 0.000001, error: null } };
    },
  },
} as unknown as Services;

beforeAll(async () => {
  const config = loadConfig({ OWNER_NAME: 'Alex', OWNER_ALIASES: 'Alexandre', INSTALL_MODE: 'single', SLACK_APP_TOKEN: 'xapp-1', SLACK_SIGNING_SECRET: 'signing-secret', SLACK_BOT_TOKEN: 'xoxb-1', ADMIN_PASSWORD: ADMIN_PW, MASTER_KEY: KEY_B64 });
  repos = createRepositories(':memory:', parseMasterKey(KEY_B64));
  const log = createLogger('warn', new Writable({ write(_c, _e, cb) { cb(); } }));
  status = createStatus();
  status.slackConnected = true;
  app = await createAdminServer({ config, log, repos, services: fakeServices, status, loginRateLimit: { max: 1000, timeWindow: '1 minute' } });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  repos.db.close();
});
beforeEach(() => {
  asked.length = 0;
  calcomUp = true;
  repos.sessions.clearLoginAttempts();
});

async function login(): Promise<{ cookie: string; csrf: string }> {
  repos.sessions.clearLoginAttempts(); // a failed attempt elsewhere in the file would delay this login (R4-1)
  const res = await app.inject({ method: 'POST', url: '/login', payload: `password=${encodeURIComponent(ADMIN_PW)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  expect(res.statusCode).toBe(302);
  const setCookie = String(res.headers['set-cookie']);
  const cookie = setCookie.split(';')[0]!;
  const page = await app.inject({ method: 'GET', url: '/settings', headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
  return { cookie, csrf };
}

describe('admin auth', () => {
  it('redirects browsers and rejects API-style calls without a session', async () => {
    const r = await app.inject({ method: 'GET', url: '/queries' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/login');
    const p = await app.inject({ method: 'POST', url: '/settings', payload: 'horizon_days=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(p.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('sets a hardened cookie on success and refuses a wrong password', async () => {
    const bad = await app.inject({ method: 'POST', url: '/login', payload: 'password=nope-nope-nope', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();
    // One failure already delays the next attempt by a second (R4-1).
    const delayed = await app.inject({ method: 'POST', url: '/login', payload: `password=${encodeURIComponent(ADMIN_PW)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(delayed.statusCode).toBe(429);
    expect(delayed.body).toContain('Try again in 1 second.');
    repos.sessions.clearLoginAttempts();
    const ok = await app.inject({ method: 'POST', url: '/login', payload: `password=${encodeURIComponent(ADMIN_PW)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const sc = String(ok.headers['set-cookie']);
    expect(sc).toMatch(/^ca_session=/);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).not.toContain('Secure');
    const https = await app.inject({ method: 'POST', url: '/login', payload: `password=${encodeURIComponent(ADMIN_PW)}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' } });
    expect(String(https.headers['set-cookie'])).toContain('Secure');
  });

  it('delays the next attempt after failures (progressive, never a long lockout) and clears on success (R4-1)', async () => {
    repos.sessions.clearLoginAttempts();
    // Four earlier failures, spaced out beyond their delays, then a fifth one now: the next attempt waits 16 s.
    const now = Date.now();
    for (const ago of [400, 300, 200, 100]) repos.db.prepare('INSERT INTO login_attempts (at, success) VALUES (?, 0)').run(new Date(now - ago * 1000).toISOString());
    expect((await app.inject({ method: 'POST', url: '/login', payload: 'password=wrong-wrong-wrong', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(401);
    const locked = await app.inject({ method: 'POST', url: '/login', payload: `password=${encodeURIComponent(ADMIN_PW)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['content-type']).toContain('text/html');
    expect(locked.body).toMatch(/Too many failed attempts\. Try again in 1[0-6] seconds\./);
    // A refused attempt during the delay is not counted: the delay stays what the fifth failure set.
    expect(repos.sessions.consecutiveFailures()).toBe(5);
    expect((await app.inject({ method: 'POST', url: '/login', payload: 'password=wrong-again-again', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(429);
    expect(repos.sessions.consecutiveFailures()).toBe(5);
    repos.sessions.clearLoginAttempts();
    expect((await app.inject({ method: 'POST', url: '/login', payload: `password=${encodeURIComponent(ADMIN_PW)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode).toBe(302);
  });

  it('logs out with the CSRF token and invalidates the session; logout without it is refused', async () => {
    const { cookie, csrf } = await login();
    const pageBody = (await app.inject({ method: 'GET', url: '/queries', headers: { cookie } })).body;
    expect(pageBody).toContain(`action="/logout" class="inline"><input type="hidden" name="_csrf" value="${csrf}">`);
    expect((await app.inject({ method: 'POST', url: '/logout', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/logout' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/queries', headers: { cookie } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/logout', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}` });
    expect((await app.inject({ method: 'GET', url: '/queries', headers: { cookie } })).statusCode).toBe(302);
  });

  it('sends security headers on every response, HSTS only over HTTPS (R4-9)', async () => {
    const r = await app.inject({ method: 'GET', url: '/login' });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['strict-transport-security']).toBeUndefined();
    const https = await app.inject({ method: 'GET', url: '/login', headers: { 'x-forwarded-proto': 'https' } });
    expect(https.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('health shows liveness to everyone and the identity only to a logged-in admin (R4-9)', async () => {
    const anon = await app.inject({ method: 'GET', url: '/health' });
    expect(anon.statusCode).toBe(200);
    expect(Object.keys(anon.json()).sort()).toEqual(['ok', 'slackConnected', 'time', 'workspaces']);
    const { cookie } = await login();
    const admin = await app.inject({ method: 'GET', url: '/health', headers: { cookie } });
    expect(admin.json()).toMatchObject({ ok: true, app: 'calendar-agent', botName: 'alex-calendar-agent', installMode: 'single' });
  });

  it('"log out everywhere" ends every session (R4-8)', async () => {
    const a = await login();
    const b = await login();
    expect((await app.inject({ method: 'GET', url: '/queries', headers: { cookie: b.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/settings', headers: { cookie: a.cookie } })).body).toContain('Log out everywhere');
    const r = await app.inject({ method: 'POST', url: '/settings/logout-all', headers: { cookie: a.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${a.csrf}` });
    expect(r.statusCode).toBe(302);
    expect((await app.inject({ method: 'GET', url: '/queries', headers: { cookie: a.cookie } })).statusCode).toBe(302);
    expect((await app.inject({ method: 'GET', url: '/queries', headers: { cookie: b.cookie } })).statusCode).toBe(302);
  });
});

describe('admin pages', () => {
  it('enforces CSRF on settings and saves encrypted keys and numbers', async () => {
    const { cookie, csrf } = await login();
    const noCsrf = await app.inject({ method: 'POST', url: '/settings', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'horizon_days=21' });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/settings', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&horizon_days=21&noise_floor_minutes=abc&calcom_api_key=cal_live_newkey123456` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Invalid values ignored: noise_floor_minutes');
    expect(repos.settings.getNumber('horizon_days')).toBe(21);
    expect(repos.settings.getSecret('calcom_api_key')!.reveal()).toBe('cal_live_newkey123456');
    const raw = repos.db.prepare("SELECT value FROM settings WHERE key='calcom_api_key'").get() as { value: string };
    expect(raw.value).not.toContain('newkey');
    const page = await app.inject({ method: 'GET', url: '/settings', headers: { cookie } });
    expect(page.body).toContain('••••3456');
    expect(page.body).not.toContain('cal_live_newkey123456');
    expect(page.body).toContain('alex-calendar-agent');
    expect(page.body).toContain('Alexandre');
  });

  it('runs the connection tests and reports failures', async () => {
    const { cookie, csrf } = await login();
    const ok = await app.inject({ method: 'POST', url: '/settings/test/calcom', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}` });
    expect(ok.body).toContain('Cal.com OK: alex');
    calcomUp = false;
    const bad = await app.inject({ method: 'POST', url: '/settings/test/calcom', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}` });
    expect(bad.body).toContain('Cal.com failed');
    const ds = await app.inject({ method: 'POST', url: '/settings/test/deepseek', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}` });
    expect(ds.body).toContain('DeepSeek OK');
  });

  it('escapes query content in the list and the detail view', async () => {
    const { cookie } = await login();
    const id = repos.queries.insert({ workspace_id: 'T1', workspace_name: '<b>Evil</b>', user_id: 'U1', user_name: 'Bob', entry_point: 'dm', channel_id: null, question: '<script>alert(1)</script> free monday?', intent: 'day', parsed_json: '{}', answer: '<img src=x onerror=alert(1)>', language: 'en', timezone_used: 'UTC', latency_ms: 1, prompt_tokens: 1, completion_tokens: 1, cost_usd: 0, error: null });
    const list = await app.inject({ method: 'GET', url: '/queries?workspace=T1', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('<script>alert(1)</script>');
    expect(list.body).toContain('&lt;script&gt;');
    expect(list.body).not.toContain('<b>Evil</b>');
    const detail = await app.inject({ method: 'GET', url: `/queries/${id}`, headers: { cookie } });
    expect(detail.body).not.toContain('<img src=x');
    expect(detail.body).toContain('&lt;img src=x');
    expect((await app.inject({ method: 'GET', url: '/queries/999999', headers: { cookie } })).statusCode).toBe(404);
    for (const page of ['1e30', '99999999999999999999', '-5', 'abc', '2.7']) expect((await app.inject({ method: 'GET', url: `/queries?page=${page}`, headers: { cookie } })).statusCode, page).toBe(200);
  });

  it('runs the sandbox through the pipeline with the chosen context and shows the debug panel', async () => {
    const { cookie, csrf } = await login();
    const r = await app.inject({ method: 'POST', url: '/sandbox', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&question=${encodeURIComponent('free Monday?')}&tz=Europe/Paris&lang=fr&now=2026-10-09T12:00` });
    expect(r.statusCode).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ userId: 'admin', entryPoint: 'sandbox', askerTz: 'Europe/Paris', askerLocale: 'fr-FR' });
    expect(asked[0]!.now!.equals(DateTime.fromISO('2026-10-09T12:00', { zone: 'Europe/Paris' }))).toBe(true);
    expect(r.body).toContain('9:00 AM to 5:00 PM');
    expect(r.body).toContain('model text accepted');
    expect(r.body).toContain('Interpretation (call 1)');
    await app.inject({ method: 'POST', url: '/sandbox', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&question=x&tz=UTC&tz_custom=Australia/Sydney&lang=en` });
    expect(asked[1]!.askerTz).toBe('Australia/Sydney');
    const badTz = await app.inject({ method: 'POST', url: '/sandbox', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&question=x&tz_custom=Mars/Olympus&lang=en` });
    expect(badTz.body).toContain('Unknown timezone');
    expect(repos.queries.list({ entryPoint: 'sandbox' }).total).toBe(2);
    // No zone chosen: the pipeline gets null, as for a Slack profile without timezone (R2-10); "now" is then UTC.
    const noZone = await app.inject({ method: 'POST', url: '/sandbox', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&question=x&tz=&lang=en&now=2026-10-09T12:00` });
    expect(noZone.statusCode).toBe(200);
    expect(asked[2]!.askerTz).toBeNull();
    expect(asked[2]!.now!.toUTC().toISO()).toBe('2026-10-09T12:00:00.000Z');
    expect((await app.inject({ method: 'GET', url: '/sandbox', headers: { cookie } })).body).toContain("(none: the owner's zone");
  });

  it('lists workspaces, removes one with CSRF, and serves the stylesheet', async () => {
    const { cookie, csrf } = await login();
    repos.installations.upsert({ teamId: 'T9', teamName: 'Acme & <Co>', enterpriseId: null, botToken: 'xoxb-9', botId: 'B9', botUserId: 'U9', scopes: ['chat:write'], installedBy: 'U1' });
    const page = await app.inject({ method: 'GET', url: '/workspaces', headers: { cookie } });
    expect(page.body).toContain('Acme &amp; &lt;Co&gt;');
    expect(page.body).toContain('a@x.com');
    expect(page.body).toContain('Single-workspace mode');
    const rm = await app.inject({ method: 'POST', url: '/workspaces/T9/remove', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}` });
    expect(rm.body).toContain('removed');
    expect(repos.installations.get('T9')).toBeNull();
    const css = await app.inject({ method: 'GET', url: '/static/admin.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect((await app.inject({ method: 'GET', url: '/static/.keep' })).statusCode).toBe(404);
  });

  it('stays usable after a master-key change: health 200, Settings and Workspaces name the unreadable rows (R3-1)', async () => {
    const { cookie, csrf } = await login();
    const before = repos.settings.getSecret('calcom_api_key')?.reveal();
    const previous = parseMasterKey(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 7) % 256)).toString('base64'), 'k0');
    repos.db.prepare("INSERT INTO settings (key, value, encrypted, updated_at) VALUES ('calcom_api_key', ?, 1, '2026-10-09T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = 1").run(encrypt(previous, 'cal_live_old', 'calcom_api_key'));
    repos.db.prepare("INSERT INTO slack_installations (team_id, team_name, enterprise_id, bot_token_enc, bot_id, bot_user_id, scopes, installed_by, installed_at, removed_at) VALUES ('TOLD', 'Stale', NULL, ?, NULL, NULL, '', 'U1', '2026-10-09T00:00:00.000Z', NULL)").run(encrypt(previous, 'xoxb-old', 'TOLD'));
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().workspaces).toBe(0);
    const settings = await app.inject({ method: 'GET', url: '/settings', headers: { cookie } });
    expect(settings.statusCode).toBe(200);
    expect(settings.body).toContain('unreadable (encrypted with a previous master key): paste it again');
    expect(settings.body).not.toContain('cal_live_old');
    const ws = await app.inject({ method: 'GET', url: '/workspaces', headers: { cookie } });
    expect(ws.statusCode).toBe(200);
    expect(ws.body).toContain('token encrypted with a previous master key');
    expect(ws.body).toContain('/workspaces/TOLD/remove');
    const rm = await app.inject({ method: 'POST', url: '/workspaces/TOLD/remove', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}` });
    expect(rm.body).toContain('removed');
    const saved = await app.inject({ method: 'POST', url: '/settings', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${csrf}&calcom_api_key=cal_live_again` });
    expect(saved.statusCode).toBe(200);
    expect(repos.settings.getSecret('calcom_api_key')!.reveal()).toBe('cal_live_again');
    if (before) repos.settings.setSecret('calcom_api_key', before);
    else repos.settings.delete('calcom_api_key');
  });

  it('single mode: the workspace seeded from .env has no Remove button, and a lost socket shows since when (R2-3, R2-7)', async () => {
    const { cookie } = await login();
    repos.installations.upsert({ teamId: 'TENV', teamName: 'Home', enterpriseId: null, botToken: 'xoxb-h', botId: null, botUserId: null, scopes: [], installedBy: 'env' });
    status.slackConnected = false;
    status.slackDisconnectedAt = '2026-10-09T12:00:00.000Z';
    const page = await app.inject({ method: 'GET', url: '/workspaces', headers: { cookie } });
    expect(page.body).toContain('from .env');
    expect(page.body).toContain('remove SLACK_BOT_TOKEN from .env');
    expect(page.body).not.toContain('/workspaces/TENV/remove');
    expect(page.body).toContain('reconnecting since 2026-10-09T12:00:00.000Z');
    status.slackConnected = true;
    status.slackDisconnectedAt = null;
  });
});

describe('login rate limiter', () => {
  it('answers with an HTML page, not JSON, once the per-minute limit is hit, keyed on the connecting socket (R2-13, R4-2)', async () => {
    const config = loadConfig({ OWNER_NAME: 'Alex', INSTALL_MODE: 'single', SLACK_APP_TOKEN: 'xapp-1', SLACK_BOT_TOKEN: 'xoxb-1', ADMIN_PASSWORD: ADMIN_PW, MASTER_KEY: KEY_B64 });
    const small = await createAdminServer({ config, log: createLogger('warn', new Writable({ write(_c, _e, cb) { cb(); } })), repos: createRepositories(':memory:', parseMasterKey(KEY_B64)), services: fakeServices, status: createStatus(), loginRateLimit: { max: 3, timeWindow: '1 minute' } });
    await small.ready();
    let last = await small.inject({ method: 'POST', url: '/login', payload: 'password=wrong-wrong-wrong', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    // A spoofed X-Forwarded-For does not give the sender a fresh bucket.
    for (let i = 0; i < 4; i++) last = await small.inject({ method: 'POST', url: '/login', payload: 'password=wrong-wrong-wrong', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `203.0.113.${i}` } });
    expect(last.statusCode).toBe(429);
    expect(last.headers['content-type']).toContain('text/html');
    expect(last.body).toContain('Too many attempts. Please wait');
    await small.close();
  });
});
