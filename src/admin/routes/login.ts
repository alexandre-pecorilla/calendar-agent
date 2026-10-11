import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, cookieOptions, lockoutRemainingSeconds, requireCsrf, requireSession, type PasswordVerifier } from '../auth.js';
import { esc, hidden, page } from '../html.js';
import type { AdminDeps } from '../server.js';

export function registerLoginRoutes(app: FastifyInstance, deps: AdminDeps, verifier: PasswordVerifier): void {
  const render = (flash: { kind: 'ok' | 'error'; text: string } | null) =>
    page({
      title: 'Log in',
      botName: deps.config.botName,
      authenticated: false,
      flash,
      body: `<h1>Admin</h1><form method="post" action="/login" class="panel" autocomplete="off">
        <label class="field"><span>Password</span><input type="password" name="password" autofocus required></label>
        <button type="submit" class="primary">Log in</button></form>`,
    });

  app.get('/login', async (req, reply) => {
    if (req.auth.session) return reply.redirect('/queries');
    return reply.type('text/html').send(render(null));
  });

  // Provenance is logged honestly (R4-2): the socket address is what the server
  // saw; the forwarded header is whatever the client (or Tailscale Serve) sent.
  const who = (req: { socket: { remoteAddress?: string | undefined }; headers: Record<string, unknown> }) => ({
    socketIp: req.socket.remoteAddress ?? null,
    forwardedFor: typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].slice(0, 64) : null,
  });

  const limit = deps.loginRateLimit ?? { max: 20, timeWindow: '1 minute' };
  app.post('/login', { config: { rateLimit: { max: limit.max, timeWindow: limit.timeWindow, keyGenerator: (req) => req.socket.remoteAddress ?? 'unknown' } } }, async (req, reply) => {
    const now = new Date();
    const wait = lockoutRemainingSeconds(deps.repos.sessions, now);
    if (wait > 0) {
      deps.log.warn({ ...who(req), wait }, 'admin login delayed');
      return reply.code(429).type('text/html').send(render({ kind: 'error', text: `Too many failed attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.` }));
    }
    const body = (req.body ?? {}) as { password?: unknown };
    const candidate = typeof body.password === 'string' ? body.password : '';
    if (!candidate || !verifier.verify(candidate)) {
      deps.repos.sessions.recordLoginAttempt(false);
      deps.log.warn(who(req), 'admin login failed');
      return reply.code(401).type('text/html').send(render({ kind: 'error', text: 'Wrong password.' }));
    }
    deps.repos.sessions.recordLoginAttempt(true);
    deps.repos.sessions.clearLoginAttempts();
    const s = deps.repos.sessions.create();
    reply.setCookie(SESSION_COOKIE, s.token, cookieOptions(req, s.expiresAt));
    deps.log.info(who(req), 'admin login ok');
    return reply.redirect('/queries');
  });

  app.post('/logout', { preHandler: [requireSession, requireCsrf] }, async (req, reply) => {
    if (req.auth.token) deps.repos.sessions.delete(req.auth.token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login');
  });

  // The CSRF hidden field for templates, filled once the session is known.
  app.addHook('preHandler', async (req) => {
    req.csrfField = req.auth.session ? hidden('_csrf', req.auth.session.csrfToken) : '';
  });
  void esc;
}
