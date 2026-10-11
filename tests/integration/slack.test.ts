import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAdminServer } from '../../src/admin/server.js';
import { createStatus } from '../../src/admin/status.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { parseMasterKey } from '../../src/crypto/envelope.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { createLogger } from '../../src/logging/logger.js';
import type { AnswerPipeline, AskContext } from '../../src/pipeline/answer.js';
import { createAuthorize, seedInstallationFromToken } from '../../src/slack/authorize.js';
import { handleDirectMessage, handleMention, handleSlashCommand, type HandlerDeps } from '../../src/slack/handlers.js';
import { installUrl, registerInstallRoutes, slackErrorDetail } from '../../src/slack/install-routes.js';
import { boltLogger, wireSocketStatus } from '../../src/slack/app.js';
import { EventEmitter } from 'node:events';
import { SqliteInstallationStore } from '../../src/slack/installation-store.js';
import { renderManifest } from '../../src/slack/manifest.js';
import { BOT_EVENTS, BOT_SCOPES } from '../../src/slack/scopes.js';
import type { Services } from '../../src/services/pipeline-factory.js';

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString('base64');
const ADMIN_PW = 'correct-horse-battery-staple';
const log = createLogger('warn', new Writable({ write(_c, _e, cb) { cb(); } }));

const single = (): AppConfig => loadConfig({ OWNER_NAME: 'Alex', INSTALL_MODE: 'single', SLACK_APP_TOKEN: 'xapp-1', SLACK_SIGNING_SECRET: 'signing-secret', SLACK_BOT_TOKEN: 'xoxb-home', ADMIN_PASSWORD: ADMIN_PW, MASTER_KEY: KEY_B64 });
const multi = (): AppConfig => loadConfig({ OWNER_NAME: 'Alex', INSTALL_MODE: 'multi', SLACK_APP_TOKEN: 'xapp-1', SLACK_SIGNING_SECRET: 'signing-secret', SLACK_BOT_TOKEN: 'xoxb-home', SLACK_CLIENT_ID: '12.34', SLACK_CLIENT_SECRET: 'cs-secret', SLACK_STATE_SECRET: 'state-secret-long-enough', PUBLIC_BASE_URL: 'https://host.example:8445', ADMIN_PASSWORD: ADMIN_PW, MASTER_KEY: KEY_B64 });

let repos: Repositories;
beforeEach(() => {
  repos = createRepositories(':memory:', parseMasterKey(KEY_B64));
});

describe('manifest', () => {
  it('uses one name everywhere, the allowlisted scopes and events, Socket Mode and the Messages tab', () => {
    const m = renderManifest(single()) as Record<string, Record<string, unknown>>;
    expect(m.display_information!.name).toBe('alex-calendar-agent');
    expect((m.features!.bot_user as { display_name: string }).display_name).toBe('alex-calendar-agent');
    expect((m.features!.slash_commands as Array<{ command: string }>)[0]!.command).toBe('/alex-calendar-agent');
    expect((m.oauth_config!.scopes as { bot: string[] }).bot).toEqual([...BOT_SCOPES]);
    expect((m.oauth_config as Record<string, unknown>).redirect_urls).toBeUndefined();
    expect((m.settings!.event_subscriptions as { bot_events: string[] }).bot_events).toEqual([...BOT_EVENTS]);
    expect(m.settings!.socket_mode_enabled).toBe(true);
    expect((m.features!.app_home as { messages_tab_enabled: boolean }).messages_tab_enabled).toBe(true);
    const mm = renderManifest(multi()) as Record<string, Record<string, unknown>>;
    expect(mm.oauth_config!.redirect_urls).toEqual(['https://host.example:8445/slack/oauth_redirect']);
    expect(JSON.stringify(mm)).not.toMatch(/user_scopes|"user":/);
  });
});

describe('installation store and authorize', () => {
  it('stores, fetches (token encrypted at rest), deletes, and refuses org installs', async () => {
    const store = new SqliteInstallationStore(repos.installations, log);
    await store.storeInstallation({ team: { id: 'T1', name: 'Acme' }, enterprise: undefined, user: { id: 'U1', token: undefined, scopes: undefined }, bot: { token: 'xoxb-1', scopes: ['chat:write'], id: 'B1', userId: 'UB1' }, tokenType: 'bot', isEnterpriseInstall: false, authVersion: 'v2' });
    const raw = repos.db.prepare('SELECT bot_token_enc FROM slack_installations').get() as { bot_token_enc: string };
    expect(raw.bot_token_enc).not.toContain('xoxb');
    const f = await store.fetchInstallation({ teamId: 'T1', enterpriseId: undefined, isEnterpriseInstall: false });
    expect(f.bot?.token).toBe('xoxb-1');
    expect(f.team?.name).toBe('Acme');
    await expect(store.fetchInstallation({ teamId: 'T2', enterpriseId: undefined, isEnterpriseInstall: false })).rejects.toThrow(/No installation/);
    await expect(store.storeInstallation({ enterprise: { id: 'E1' }, team: undefined, user: { id: 'U', token: undefined, scopes: undefined }, isEnterpriseInstall: true, tokenType: 'bot', authVersion: 'v2' } as never)).rejects.toThrow(/Organisation-wide/);
    await store.deleteInstallation!({ teamId: 'T1', enterpriseId: undefined, isEnterpriseInstall: false });
    expect(repos.installations.get('T1')).toBeNull();
  });

  it('authorize returns the right token per team and never another workspace\'s', async () => {
    repos.installations.upsert({ teamId: 'T1', teamName: 'A', enterpriseId: null, botToken: 'xoxb-a', botId: 'B1', botUserId: 'UB1', scopes: [], installedBy: null });
    repos.installations.upsert({ teamId: 'T2', teamName: 'B', enterpriseId: null, botToken: 'xoxb-b', botId: null, botUserId: null, scopes: [], installedBy: null });
    const authorize = createAuthorize(repos.installations);
    expect(await authorize({ teamId: 'T1', enterpriseId: undefined, isEnterpriseInstall: false })).toEqual({ botToken: 'xoxb-a', teamId: 'T1', botId: 'B1', botUserId: 'UB1' });
    expect(await authorize({ teamId: 'T2', enterpriseId: undefined, isEnterpriseInstall: false })).toEqual({ botToken: 'xoxb-b', teamId: 'T2' });
    await expect(authorize({ teamId: 'T3', enterpriseId: undefined, isEnterpriseInstall: false })).rejects.toThrow(/not installed/);
    await expect(authorize({ teamId: undefined, enterpriseId: 'E1', isEnterpriseInstall: true })).rejects.toThrow(/Organisation-wide/);
  });

  it('seeds from the env token once via auth.test and keeps an existing row', async () => {
    const authTest = async () => ({ team_id: 'T9', team: 'Home', user_id: 'UB9', bot_id: 'B9' });
    expect(await seedInstallationFromToken(repos.installations, 'xoxb-env', authTest, BOT_SCOPES)).toEqual({ teamId: 'T9', teamName: 'Home', seeded: true });
    expect(repos.installations.get('T9')!.scopes).toEqual([...BOT_SCOPES]);
    expect(await seedInstallationFromToken(repos.installations, 'xoxb-newer', authTest, BOT_SCOPES)).toMatchObject({ seeded: false });
    expect(repos.installations.get('T9')!.botToken.reveal()).toBe('xoxb-env');
    await expect(seedInstallationFromToken(repos.installations, 'xoxb', async () => ({}), BOT_SCOPES)).rejects.toThrow(/no team id/);
  });
});

describe('handlers', () => {
  const asks: Array<{ ctx: AskContext; text: string }> = [];
  const pipeline = { ask: async (ctx: AskContext, text: string) => { asks.push({ ctx, text }); if (text === 'boom') throw new Error('x'); return { text: `reply:${text}`, intent: 'day', language: 'en' as const, queryId: 1, debug: {} as never }; } } as unknown as AnswerPipeline;
  const usersInfo = { users: { info: async ({ user }: { user: string }) => ({ user: { tz: user === 'UFR' ? 'Europe/Paris' : 'America/New_York', locale: user === 'UFR' ? 'fr-FR' : 'en-US', real_name: 'Bob' } }) } } as never;
  let deps: HandlerDeps;
  beforeEach(() => {
    asks.length = 0;
    repos.installations.upsert({ teamId: 'T1', teamName: 'Acme', enterpriseId: null, botToken: 'xoxb-a', botId: null, botUserId: null, scopes: [], installedBy: null });
    deps = { config: single(), repos, pipeline, status: createStatus(), log };
  });

  it('answers DMs, ignores bots, edits and non-DM messages', async () => {
    const said: unknown[] = [];
    const say = async (m: unknown) => { said.push(m); };
    expect(await handleDirectMessage(deps, { event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'UFR', text: 'lundi ?', ts: '1' }, teamId: 'T1', client: usersInfo, say })).toBe(true);
    expect(said).toEqual([{ text: 'reply:lundi ?' }]);
    expect(asks[0]!.ctx).toMatchObject({ userId: 'UFR', userName: 'Bob', workspaceId: 'T1', workspaceName: 'Acme', entryPoint: 'dm', channelId: 'D1', askerTz: 'Europe/Paris', askerLocale: 'fr-FR' });
    expect(await handleDirectMessage(deps, { event: { type: 'message', channel: 'D1', channel_type: 'im', bot_id: 'B9', text: 'x', ts: '2' }, teamId: 'T1', client: usersInfo, say })).toBe(false);
    expect(await handleDirectMessage(deps, { event: { type: 'message', channel: 'D1', channel_type: 'im', subtype: 'message_changed', user: 'U1', text: 'x', ts: '3' }, teamId: 'T1', client: usersInfo, say })).toBe(false);
    expect(await handleDirectMessage(deps, { event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'x', ts: '4' }, teamId: 'T1', client: usersInfo, say })).toBe(false);
    expect(said).toHaveLength(1);
    expect(deps.status.slackLastEventAt).not.toBeNull();
  });

  it('answers mentions in a thread under the message, or in the existing thread', async () => {
    const said: Array<{ text: string; thread_ts?: string }> = [];
    const say = async (m: { text: string; thread_ts?: string }) => { said.push(m); };
    await handleMention(deps, { event: { type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> free Monday?', ts: '100.1' }, teamId: 'T1', client: usersInfo, say });
    await handleMention(deps, { event: { type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> and Tuesday?', ts: '100.2', thread_ts: '100.1' }, teamId: 'T1', client: usersInfo, say });
    expect(said.map((s) => s.thread_ts)).toEqual(['100.1', '100.1']);
    expect(asks[0]!.ctx.entryPoint).toBe('mention');
  });

  it('acknowledges the slash command first, then replaces the placeholder with an ephemeral answer', async () => {
    const order: string[] = [];
    await handleSlashCommand(deps, {
      command: { command: '/alex-calendar-agent', text: 'Monday 4pm?', user_id: 'U1', channel_id: 'C1', team_id: 'T1' },
      ack: async (m) => { order.push(`ack:${m?.response_type}`); },
      respond: async (m) => { order.push(`respond:${m.response_type}:${m.replace_original}:${m.text}`); },
      client: usersInfo,
    });
    expect(order).toEqual(['ack:ephemeral', 'respond:ephemeral:true:reply:Monday 4pm?']);
    expect(asks[0]!.ctx.entryPoint).toBe('slash');
  });

  it('never throws into Bolt: a pipeline failure becomes the cannot-check reply', async () => {
    const said: Array<{ text: string }> = [];
    await handleDirectMessage(deps, { event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'UFR', text: 'boom', ts: '1' }, teamId: 'T1', client: usersInfo, say: async (m) => { said.push(m); } });
    expect(said[0]!.text).toContain("Je ne peux pas consulter");
  });

  it('falls back to the owner zone when users.info fails', async () => {
    const failing = { users: { info: async () => { throw new Error('missing_scope'); } } } as never;
    await handleDirectMessage(deps, { event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: 'x', ts: '1' }, teamId: 'T1', client: failing, say: async () => {} });
    expect(asks[0]!.ctx.askerTz).toBeNull();
  });
});

describe('install routes', () => {
  let app: FastifyInstance;
  const fake = { calcom: {}, calcomCache: { calendars: async () => [], defaultSchedule: async () => null, selectedCalendars: async () => [], invalidate() {} }, deepseek: {}, pipeline: {} } as unknown as Services;
  async function login(server: FastifyInstance): Promise<string> {
    const res = await server.inject({ method: 'POST', url: '/login', payload: `password=${encodeURIComponent(ADMIN_PW)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return String(res.headers['set-cookie']).split(';')[0]!;
  }
  afterAll(async () => { await app?.close(); });

  it('multi mode: install path needs a session, starts only on the HTTPS origin, redirects to Slack with the right scopes; a bad callback is a 400 page', async () => {
    const config = multi();
    app = await createAdminServer({ config, log, repos, services: fake, status: createStatus(), extraRoutes: (a) => registerInstallRoutes(a, { config, repos, log }) });
    await app.ready();
    expect(installUrl(config)).toBe('https://host.example:8445/slack/install');
    expect((await app.inject({ method: 'GET', url: '/slack/install' })).statusCode).toBe(302);
    const cookie = await login(app);
    // Plain HTTP (the loopback or Tailscale-IP address): sent to the HTTPS origin first (R2-1).
    const plain = await app.inject({ method: 'GET', url: '/slack/install', headers: { cookie } });
    expect(plain.statusCode).toBe(302);
    expect(plain.headers.location).toBe('https://host.example:8445/slack/install');
    expect(plain.headers['set-cookie']).toBeUndefined();
    const onOrigin = { cookie, 'x-forwarded-host': 'host.example:8445', 'x-forwarded-proto': 'https' };
    const r = await app.inject({ method: 'GET', url: '/slack/install', headers: onOrigin });
    expect(r.statusCode).toBe(302);
    const loc = new URL(String(r.headers.location));
    expect(loc.origin + loc.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(loc.searchParams.get('client_id')).toBe('12.34');
    expect(loc.searchParams.get('scope')).toBe(BOT_SCOPES.join(','));
    expect(loc.searchParams.get('redirect_uri')).toBe('https://host.example:8445/slack/oauth_redirect');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(String(r.headers['set-cookie'])).toMatch(/slack-app-oauth-state=.*Secure/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    // A forged host over HTTPS never reaches Slack with our redirect URI: it is sent home instead.
    const forgedHost = await app.inject({ method: 'GET', url: '/slack/install', headers: { cookie, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } });
    expect(forgedHost.headers.location).toBe('https://host.example:8445/slack/install');
    const cb = await app.inject({ method: 'GET', url: '/slack/oauth_redirect?code=abc&state=forged' });
    expect(cb.statusCode).toBe(400);
    expect(cb.body).toContain('Install failed');
    expect(cb.body).toContain('slack_oauth_invalid_state');
    expect(cb.body).toContain('https://host.example:8445/slack/install');
    expect(cb.headers['x-frame-options']).toBe('DENY');
    expect(cb.headers['content-security-policy']).toContain("default-src 'self'");
    // The Workspaces page links to the absolute HTTPS install address.
    const ws = await app.inject({ method: 'GET', url: '/workspaces', headers: { cookie } });
    expect(ws.body).toContain('href="https://host.example:8445/slack/install"');
    await app.close();
  });

  it('reads the Slack-side reason out of a wrapped platform error (R2-5)', () => {
    expect(slackErrorDetail(Object.assign(new Error('x'), { code: 'slack_webapi_platform_error', data: { ok: false, error: 'bad_client_secret' } }))).toBe('bad_client_secret');
    expect(slackErrorDetail(new Error('plain'))).toBeNull();
    expect(slackErrorDetail({ data: { error: 42 } })).toBeNull();
  });

  it('single mode: no install routes', async () => {
    const config = single();
    const s = await createAdminServer({ config, log, repos, services: fake, status: createStatus(), extraRoutes: (a) => registerInstallRoutes(a, { config, repos, log }) });
    await s.ready();
    const cookie = await login(s);
    expect((await s.inject({ method: 'GET', url: '/slack/install', headers: { cookie } })).statusCode).toBe(404);
    expect((await s.inject({ method: 'GET', url: '/slack/oauth_redirect?code=x&state=y' })).statusCode).toBe(404);
    await s.close();
  });

  it('Bolt debug output never reaches the log, whatever LOG_LEVEL says (R4-3)', () => {
    const chunks: string[] = [];
    const capture = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
    const l = boltLogger(createLogger('debug', capture));
    l.debug('{"event":{"text":"is the owner free Monday? CANARY-QUESTION-TEXT"}}');
    l.setLevel('debug' as never);
    l.debug('CANARY-AFTER-SETLEVEL');
    l.info('socket connected');
    l.warn('retrying');
    const out = chunks.join('');
    expect(out).not.toContain('CANARY');
    expect(out).toContain('socket connected');
    expect(out).toContain('retrying');
    expect(l.getLevel()).toBe('info');
  });

  it('socket status: reconnecting and disconnecting clear the flag and record when the socket was lost (R2-3)', () => {
    const status = createStatus();
    const client = new EventEmitter();
    let t = 0;
    wireSocketStatus(client, status, log, () => new Date(Date.UTC(2026, 9, 9, 12, 0, t++)));
    client.emit('connected');
    expect(status.slackConnected).toBe(true);
    expect(status.slackDisconnectedAt).toBeNull();
    client.emit('reconnecting');
    expect(status.slackConnected).toBe(false);
    expect(status.slackDisconnectedAt).toBe('2026-10-09T12:00:00.000Z');
    client.emit('reconnecting');
    expect(status.slackDisconnectedAt).toBe('2026-10-09T12:00:00.000Z');
    client.emit('connected');
    expect(status).toMatchObject({ slackConnected: true, slackDisconnectedAt: null });
    client.emit('disconnecting');
    expect(status.slackConnected).toBe(false);
    client.emit('disconnected');
    expect(status.slackConnected).toBe(false);
  });
});
