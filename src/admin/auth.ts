import type { MasterKey } from '../crypto/envelope.js';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionsRepository, Session } from '../db/repos/sessions.js';
import type { SettingsRepository } from '../db/repos/settings.js';

export const SESSION_COOKIE = 'ca_session';
/** The delay after n consecutive failures is min(2^(n-1), 60) seconds (R4-1). */
export const LOGIN_DELAY_MAX_SECONDS = 60;
const PASSWORD_FINGERPRINT_KEY = 'admin_password_fingerprint';

/**
 * Password verification: the configured password is hashed with scrypt at
 * boot (random salt, never stored) and candidates are compared in constant
 * time. The plaintext is dropped right after hashing.
 */
export class PasswordVerifier {
  private readonly salt: Buffer;
  private readonly hash: Buffer;

  constructor(password: string) {
    this.salt = randomBytes(16);
    this.hash = scryptSync(password, this.salt, 32, { N: 16384, r: 8, p: 1 });
  }

  verify(candidate: string): boolean {
    const h = scryptSync(candidate, this.salt, 32, { N: 16384, r: 8, p: 1 });
    return timingSafeEqual(h, this.hash);
  }
}

export interface AuthState {
  session: Session | null;
  token: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthState;
    /** Hidden CSRF input for forms, empty when unauthenticated. */
    csrfField: string;
  }
}

export function readSession(req: FastifyRequest, sessions: SessionsRepository): AuthState {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return { session: null, token: null };
  const session = sessions.find(token);
  return { session, token: session ? token : null };
}

export function cookieOptions(req: FastifyRequest, expiresAt: string) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: req.protocol === 'https',
    expires: new Date(expiresAt),
  };
}

/** Redirect browsers, 401 for everything else, when no valid session exists. */
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.auth.session) return;
  if (req.method === 'GET' || req.method === 'HEAD') {
    reply.redirect('/login');
    return reply;
  }
  reply.code(401).send({ error: 'unauthenticated' });
  return reply;
}

/** Double-submit CSRF: the form carries the session's CSRF token. */
export async function requireCsrf(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const given = typeof body._csrf === 'string' ? body._csrf : '';
  const expected = req.auth.session?.csrfToken ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    reply.code(403).send({ error: 'csrf' });
    return reply;
  }
}

export function loginDelaySeconds(consecutiveFailures: number): number {
  return consecutiveFailures <= 0 ? 0 : Math.min(2 ** (consecutiveFailures - 1), LOGIN_DELAY_MAX_SECONDS);
}

/**
 * Seconds before the next login attempt is accepted: a progressive delay after
 * each failure (1 s, 2 s, 4 s … capped at 60 s), measured from the last failure.
 * Global on purpose (one owner, no trustworthy client key behind a proxy): it
 * caps guessing at about one try a minute without ever refusing the right
 * password for more than a minute (R4-1). Attempts made during the delay are
 * refused and not counted.
 */
export function lockoutRemainingSeconds(sessions: SessionsRepository, now: Date): number {
  const last = sessions.lastFailedLoginAt();
  if (!last) return 0;
  const delayMs = loginDelaySeconds(sessions.consecutiveFailures()) * 1000;
  const remainingMs = new Date(last).getTime() + delayMs - now.getTime();
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

/**
 * A non-secret fingerprint of the admin password (HMAC under the master key,
 * truncated) kept in `settings`; when it changes between boots every session
 * is ended, so rotating the password really logs everyone out (R4-8).
 */
export function syncPasswordFingerprint(settings: SettingsRepository, sessions: SessionsRepository, master: MasterKey, password: string): { changed: boolean; sessionsCleared: number } {
  const fingerprint = createHmac('sha256', master.key).update(password).digest('hex').slice(0, 16);
  const previous = settings.get(PASSWORD_FINGERPRINT_KEY);
  if (previous === fingerprint) return { changed: false, sessionsCleared: 0 };
  const sessionsCleared = previous === null ? 0 : sessions.deleteAll();
  settings.set(PASSWORD_FINGERPRINT_KEY, fingerprint);
  return { changed: previous !== null, sessionsCleared };
}
