import { createHash, randomBytes } from 'node:crypto';
import { nowIso, type Database } from '../sqlite.js';

export interface Session {
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export const SESSION_TTL_DAYS = 30;
/** A session unused for this long ends even before its TTL (R4-8). */
export const SESSION_IDLE_DAYS = 7;
/** Login attempts older than this are irrelevant to the progressive delay and are purged. */
const LOGIN_ATTEMPTS_KEEP_HOURS = 24;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Opaque session tokens hashed at rest (pattern from an earlier internal project): a stolen database
 * yields no usable cookie. Login attempts are stored too, so a lockout survives
 * a restart.
 */
export class SessionsRepository {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(ttlDays = SESSION_TTL_DAYS): { token: string; csrfToken: string; expiresAt: string } {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const created = this.now();
    const expires = new Date(created.getTime() + ttlDays * 86_400_000);
    this.db
      .prepare('INSERT INTO sessions (token_hash, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(hash(token), csrfToken, created.toISOString(), expires.toISOString(), created.toISOString());
    return { token, csrfToken, expiresAt: expires.toISOString() };
  }

  find(token: string): Session | null {
    const row = this.db.prepare('SELECT csrf_token, created_at, expires_at, last_seen_at FROM sessions WHERE token_hash = ?').get(hash(token)) as
      | { csrf_token: string; created_at: string; expires_at: string; last_seen_at: string }
      | undefined;
    if (!row) return null;
    const nowMs = this.now().getTime();
    if (new Date(row.expires_at).getTime() <= nowMs || new Date(row.last_seen_at).getTime() + SESSION_IDLE_DAYS * 86_400_000 <= nowMs) {
      this.delete(token);
      return null;
    }
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(this.now().toISOString(), hash(token));
    return { csrfToken: row.csrf_token, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  delete(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
  }

  deleteAll(): number {
    return Number(this.db.prepare('DELETE FROM sessions').run().changes);
  }

  purgeExpired(): number {
    const now = this.now();
    const idleBefore = new Date(now.getTime() - SESSION_IDLE_DAYS * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM login_attempts WHERE at < ?').run(new Date(now.getTime() - LOGIN_ATTEMPTS_KEEP_HOURS * 3_600_000).toISOString());
    return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now.toISOString(), idleBefore).changes);
  }

  recordLoginAttempt(success: boolean): void {
    this.db.prepare('INSERT INTO login_attempts (at, success) VALUES (?, ?)').run(this.now().toISOString(), success ? 1 : 0);
  }

  failedLoginsSince(sinceIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE success = 0 AND at >= ?').get(sinceIso) as { n: number }).n;
  }

  /** When the last failed login happened, or null (R4-1). */
  lastFailedLoginAt(): string | null {
    const row = this.db.prepare('SELECT MAX(at) AS at FROM login_attempts WHERE success = 0').get() as { at: string | null };
    return row.at ?? null;
  }

  /** Failed logins since the last successful one (R4-1). */
  consecutiveFailures(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE success = 0 AND at > COALESCE((SELECT MAX(at) FROM login_attempts WHERE success = 1), '')")
        .get() as { n: number }
    ).n;
  }

  clearLoginAttempts(): void {
    this.db.prepare('DELETE FROM login_attempts').run();
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  }
}

export { nowIso };
