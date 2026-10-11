import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, parseMasterKey } from '../../src/crypto/envelope.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedSecretsFromEnv } from '../../src/db/repos/settings.js';
import { backupDatabase, openDatabase } from '../../src/db/sqlite.js';
import { SessionsRepository } from '../../src/db/repos/sessions.js';
import { DatabaseSync } from 'node:sqlite';

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString('base64');
const master = parseMasterKey(KEY_B64);

let dir: string;
let repos: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'calendar-agent-'));
  repos = createRepositories(dir, master);
});
afterEach(() => {
  repos.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('creates every table and is idempotent', () => {
    const tables = (repos.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of ['settings', 'queries', 'slack_installations', 'sessions', 'login_attempts', 'slack_user_cache', 'schema_migrations']) {
      expect(tables).toContain(t);
    }
    const again = runMigrations(repos.db);
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBeGreaterThan(0);
  });

  it('rolls back a failing migration and records nothing', () => {
    const mdir = join(dir, 'migrations');
    mkdirSync(mdir);
    writeFileSync(join(mdir, '0001_ok.sql'), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(mdir, '0002_bad.sql'), 'CREATE TABLE b (y INTEGER); THIS IS NOT SQL;');
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, mdir + '/')).toThrow(/0002_bad/);
    const names = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(['0001_ok.sql']);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).not.toContain('b');
    db.close();
  });
});

describe('settings', () => {
  it('stores secrets encrypted and plain values in clear', () => {
    repos.settings.setSecret('calcom_api_key', 'cal_live_abcdef');
    repos.settings.set('horizon_days', '21');
    const raw = repos.db.prepare('SELECT key, value, encrypted FROM settings ORDER BY key').all() as Array<{ key: string; value: string; encrypted: number }>;
    const secret = raw.find((r) => r.key === 'calcom_api_key')!;
    expect(secret.encrypted).toBe(1);
    expect(secret.value).toMatch(/^v1\.k1\./);
    expect(secret.value).not.toContain('cal_live');
    expect(repos.settings.getSecret('calcom_api_key')!.reveal()).toBe('cal_live_abcdef');
    expect(repos.settings.getNumber('horizon_days')).toBe(21);
    expect(repos.settings.getNumber('noise_floor_minutes')).toBe(15);
    expect(() => repos.settings.get('calcom_api_key')).toThrow(/encrypted/);
    expect(repos.settings.list().find((r) => r.key === 'calcom_api_key')!.masked).toBe('••••cdef');
  });

  it('seeds from env once and never overwrites', () => {
    expect(seedSecretsFromEnv(repos.settings, { CALCOM_API_KEY: 'cal_live_one', DEEPSEEK_API_KEY: ' sk-two ' })).toEqual(['calcom_api_key', 'deepseek_api_key']);
    expect(repos.settings.getSecret('deepseek_api_key')!.reveal()).toBe('sk-two');
    expect(seedSecretsFromEnv(repos.settings, { CALCOM_API_KEY: 'cal_live_other' })).toEqual([]);
    expect(repos.settings.getSecret('calcom_api_key')!.reveal()).toBe('cal_live_one');
    expect(seedSecretsFromEnv(repos.settings, {})).toEqual([]);
  });

  it('never seeds a template placeholder, and re-seeds a row the current master key cannot read (R3-1, R3-2)', () => {
    expect(seedSecretsFromEnv(repos.settings, { CALCOM_API_KEY: 'cal_live_...', DEEPSEEK_API_KEY: 'sk-…' })).toEqual([]);
    expect(repos.settings.has('calcom_api_key')).toBe(false);
    const previous = parseMasterKey(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 7) % 256)).toString('base64'), 'k0');
    repos.db.prepare("INSERT INTO settings (key, value, encrypted, updated_at) VALUES ('calcom_api_key', ?, 1, '2026-10-09T00:00:00.000Z')").run(encrypt(previous, 'cal_live_old', 'calcom_api_key'));
    expect(repos.settings.isUnreadable('calcom_api_key')).toBe(true);
    expect(seedSecretsFromEnv(repos.settings, { CALCOM_API_KEY: 'cal_live_new' })).toEqual(['calcom_api_key']);
    expect(repos.settings.getSecret('calcom_api_key')!.reveal()).toBe('cal_live_new');
    expect(repos.settings.isUnreadable('calcom_api_key')).toBe(false);
  });

  it('treats a row encrypted with a previous master key as absent and reports it (R3-1)', () => {
    const previous = parseMasterKey(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 7) % 256)).toString('base64'), 'k0');
    repos.db.prepare("INSERT INTO settings (key, value, encrypted, updated_at) VALUES ('deepseek_api_key', ?, 1, '2026-10-09T00:00:00.000Z')").run(encrypt(previous, 'sk-old', 'deepseek_api_key'));
    expect(repos.settings.getSecret('deepseek_api_key')).toBeNull();
    expect(repos.settings.unreadable()).toEqual([{ key: 'deepseek_api_key', keyId: 'k0' }]);
    expect(repos.settings.list().find((r) => r.key === 'deepseek_api_key')).toMatchObject({ encrypted: true, masked: null, unreadable: true });
    repos.settings.setSecret('deepseek_api_key', 'sk-again');
    expect(repos.settings.getSecret('deepseek_api_key')!.reveal()).toBe('sk-again');
    expect(repos.settings.unreadable()).toEqual([]);
  });
});

describe('queries', () => {
  const base = {
    workspace_id: 'T1', workspace_name: 'Acme', user_id: 'U1', user_name: 'Bob', entry_point: 'dm' as const, channel_id: 'D1',
    question: 'free monday?', intent: 'day', parsed_json: '{}', answer: 'yes', language: 'en', timezone_used: 'America/New_York',
    latency_ms: 1200, prompt_tokens: 100, completion_tokens: 20, cost_usd: 0.0001, error: null,
  };
  it('inserts, lists with filters, and counts for rate limits', () => {
    const t0 = '2026-10-09T10:00:00.000Z';
    repos.queries.insert({ ...base, received_at: t0 });
    repos.queries.insert({ ...base, received_at: '2026-10-09T10:00:30.000Z', entry_point: 'mention' });
    repos.queries.insert({ ...base, received_at: '2026-10-09T10:00:40.000Z', entry_point: 'sandbox', user_id: 'admin' });
    repos.queries.insert({ ...base, received_at: '2026-10-09T09:00:00.000Z', user_id: 'U2', workspace_id: 'T2' });
    expect(repos.queries.list().total).toBe(4);
    expect(repos.queries.list({ userId: 'U1' }).total).toBe(2);
    expect(repos.queries.list({ workspaceId: 'T2' }).rows[0]!.user_id).toBe('U2');
    expect(repos.queries.list({ entryPoint: 'sandbox' }).total).toBe(1);
    expect(repos.queries.list({ from: '2026-10-09T10:00:00.000Z' }).total).toBe(3);
    expect(repos.queries.countUserSince('U1', t0)).toBe(2);
    expect(repos.queries.countWorkspaceSince('T1', t0)).toBe(2);
    expect(repos.queries.countSince('2026-10-09T00:00:00.000Z')).toBe(3);
    expect(repos.queries.get(1)!.question).toBe('free monday?');
    expect(repos.queries.distinctWorkspaces().map((w) => w.workspace_id)).toEqual(['T1', 'T2']);
  });
});

describe('installations', () => {
  it('encrypts the bot token with the team id and supports removal', () => {
    repos.installations.upsert({ teamId: 'T1', teamName: 'Acme', enterpriseId: null, botToken: 'xoxb-1-2-3', botId: 'B1', botUserId: 'U9', scopes: ['chat:write'], installedBy: 'U1' });
    const raw = repos.db.prepare('SELECT bot_token_enc FROM slack_installations').get() as { bot_token_enc: string };
    expect(raw.bot_token_enc).not.toContain('xoxb');
    const inst = repos.installations.get('T1')!;
    expect(inst.botToken.reveal()).toBe('xoxb-1-2-3');
    expect(String(inst.botToken)).toBe('[secret]');
    expect(inst.scopes).toEqual(['chat:write']);
    expect(repos.installations.remove('T1')).toBe(true);
    expect(repos.installations.get('T1')).toBeNull();
    expect(repos.installations.list()).toEqual([]);
    repos.installations.upsert({ teamId: 'T1', teamName: 'Acme', enterpriseId: null, botToken: 'xoxb-new', botId: null, botUserId: null, scopes: [], installedBy: null });
    expect(repos.installations.get('T1')!.botToken.reveal()).toBe('xoxb-new');
  });
});

describe('installations after a master-key change', () => {
  it('lists readable workspaces only, reports the others, still removes them, and lets the env seeding replace them (R3-1)', () => {
    const previous = parseMasterKey(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 7) % 256)).toString('base64'), 'k0');
    repos.installations.upsert({ teamId: 'TOK', teamName: 'Readable', enterpriseId: null, botToken: 'xoxb-ok', botId: null, botUserId: null, scopes: [], installedBy: 'U1' });
    repos.db.prepare("INSERT INTO slack_installations (team_id, team_name, enterprise_id, bot_token_enc, bot_id, bot_user_id, scopes, installed_by, installed_at, removed_at) VALUES ('TOLD', 'Stale', NULL, ?, NULL, NULL, '', 'env', '2026-10-09T00:00:00.000Z', NULL)").run(encrypt(previous, 'xoxb-old', 'TOLD'));
    expect(repos.installations.list().map((i) => i.teamId)).toEqual(['TOK']);
    expect(repos.installations.get('TOLD')).toBeNull();
    expect(repos.installations.unreadable()).toEqual([{ teamId: 'TOLD', teamName: 'Stale', installedBy: 'env', keyId: 'k0' }]);
    repos.installations.upsert({ teamId: 'TOLD', teamName: 'Stale', enterpriseId: null, botToken: 'xoxb-new', botId: null, botUserId: null, scopes: [], installedBy: 'env' });
    expect(repos.installations.get('TOLD')!.botToken.reveal()).toBe('xoxb-new');
    expect(repos.installations.unreadable()).toEqual([]);
    repos.db.prepare("UPDATE slack_installations SET bot_token_enc = ? WHERE team_id = 'TOLD'").run(encrypt(previous, 'xoxb-old', 'TOLD'));
    expect(repos.installations.remove('TOLD')).toBe(true);
    expect(repos.installations.unreadable()).toEqual([]);
  });
});

describe('sessions', () => {
  it('creates, finds, expires and deletes sessions; records login attempts', () => {
    const s = repos.sessions.create(1);
    expect(repos.sessions.find(s.token)!.csrfToken).toBe(s.csrfToken);
    expect(repos.sessions.find('nope')).toBeNull();
    const raw = repos.db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(raw.token_hash).not.toBe(s.token);
    repos.sessions.delete(s.token);
    expect(repos.sessions.find(s.token)).toBeNull();
    repos.sessions.recordLoginAttempt(false);
    repos.sessions.recordLoginAttempt(false);
    repos.sessions.recordLoginAttempt(true);
    expect(repos.sessions.failedLoginsSince('2000-01-01T00:00:00.000Z')).toBe(2);
  });

  it('treats an expired session as absent', () => {
    let t = new Date('2026-10-09T00:00:00Z');
    const repo = new SessionsRepository(repos.db, () => t);
    const s = repo.create(1);
    t = new Date('2026-10-10T00:00:01Z');
    expect(repo.find(s.token)).toBeNull();
    expect(repo.count()).toBe(0);
  });
});

describe('slack user cache', () => {
  it('returns cached values within the max age only', () => {
    const t0 = new Date('2026-10-09T10:00:00Z');
    repos.slackUsers.set('T1', 'U1', { tz: 'Europe/Paris', locale: 'fr-FR', name: 'Bob' }, t0);
    expect(repos.slackUsers.get('T1', 'U1', 3_600_000, new Date('2026-10-09T10:30:00Z'))!.tz).toBe('Europe/Paris');
    expect(repos.slackUsers.get('T1', 'U1', 3_600_000, new Date('2026-10-09T11:30:00Z'))).toBeNull();
  });
});

describe('backup', () => {
  it('produces a readable snapshot', async () => {
    repos.settings.set('horizon_days', '14');
    const dest = join(dir, 'snapshot.db');
    await backupDatabase(repos.db, dest);
    const copy = openDatabase(dir);
    copy.close();
    const snap = new DatabaseSync(dest);
    expect((snap.prepare("SELECT value FROM settings WHERE key='horizon_days'").get() as { value: string }).value).toBe('14');
    snap.close();
    expect(readdirSync(dir)).toContain('snapshot.db');
  });
});
