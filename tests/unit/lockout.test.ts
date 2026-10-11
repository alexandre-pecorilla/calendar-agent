import { describe, expect, it } from 'vitest';
import { lockoutRemainingSeconds, loginDelaySeconds, syncPasswordFingerprint } from '../../src/admin/auth.js';
import { parseMasterKey } from '../../src/crypto/envelope.js';
import { createRepositories } from '../../src/db/index.js';
import { SessionsRepository } from '../../src/db/repos/sessions.js';

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString('base64');
const master = parseMasterKey(KEY_B64);

/** The progressive login delay (R4-1) and the password fingerprint (R4-8). */
describe('login delay', () => {
  it('doubles from one second and caps at sixty, measured from the last failure, cleared by a success', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 20].map(loginDelaySeconds)).toEqual([0, 1, 2, 4, 8, 16, 32, 60, 60, 60]);
    const repos = createRepositories(':memory:', master);
    const clock = { t: new Date('2026-10-09T12:00:00.000Z') };
    const sessions = new SessionsRepository(repos.db, () => clock.t);
    const at = (iso: string) => new Date(iso);
    expect(lockoutRemainingSeconds(sessions, clock.t)).toBe(0);
    sessions.recordLoginAttempt(false);
    expect(lockoutRemainingSeconds(sessions, at('2026-10-09T12:00:00.000Z'))).toBe(1);
    expect(lockoutRemainingSeconds(sessions, at('2026-10-09T12:00:01.000Z'))).toBe(0);
    for (let i = 0; i < 6; i++) {
      clock.t = new Date(clock.t.getTime() + 60_000);
      sessions.recordLoginAttempt(false);
    }
    expect(sessions.consecutiveFailures()).toBe(7);
    expect(lockoutRemainingSeconds(sessions, clock.t)).toBe(60);
    expect(lockoutRemainingSeconds(sessions, new Date(clock.t.getTime() + 59_000))).toBe(1);
    expect(lockoutRemainingSeconds(sessions, new Date(clock.t.getTime() + 60_000))).toBe(0);
    // Old failures never delay a later attempt by more than the cap.
    expect(lockoutRemainingSeconds(sessions, new Date(clock.t.getTime() + 86_400_000))).toBe(0);
    sessions.recordLoginAttempt(true);
    expect(sessions.consecutiveFailures()).toBe(0);
    sessions.clearLoginAttempts();
    expect(lockoutRemainingSeconds(sessions, clock.t)).toBe(0);
    // Attempts older than a day are purged with the expired sessions.
    sessions.recordLoginAttempt(false);
    clock.t = new Date(clock.t.getTime() + 2 * 86_400_000);
    sessions.purgeExpired();
    expect(sessions.lastFailedLoginAt()).toBeNull();
    repos.db.close();
  });

  it('idle sessions end after seven days even before their 30-day expiry (R4-8)', () => {
    const repos = createRepositories(':memory:', master);
    const clock = { t: new Date('2026-10-09T12:00:00.000Z') };
    const sessions = new SessionsRepository(repos.db, () => clock.t);
    const s = sessions.create();
    clock.t = new Date(clock.t.getTime() + 6 * 86_400_000);
    expect(sessions.find(s.token)).not.toBeNull();
    clock.t = new Date(clock.t.getTime() + 8 * 86_400_000);
    expect(sessions.find(s.token)).toBeNull();
    repos.db.close();
  });
});

describe('password fingerprint', () => {
  it('ends every session when ADMIN_PASSWORD changes between boots, and nothing otherwise', () => {
    const repos = createRepositories(':memory:', master);
    expect(syncPasswordFingerprint(repos.settings, repos.sessions, master, 'first-password')).toEqual({ changed: false, sessionsCleared: 0 });
    const s = repos.sessions.create();
    expect(syncPasswordFingerprint(repos.settings, repos.sessions, master, 'first-password')).toEqual({ changed: false, sessionsCleared: 0 });
    expect(repos.sessions.find(s.token)).not.toBeNull();
    expect(syncPasswordFingerprint(repos.settings, repos.sessions, master, 'second-password')).toEqual({ changed: true, sessionsCleared: 1 });
    expect(repos.sessions.find(s.token)).toBeNull();
    const stored = repos.settings.get('admin_password_fingerprint')!;
    expect(stored).toHaveLength(16);
    expect(stored).not.toContain('second');
    repos.db.close();
  });
});
