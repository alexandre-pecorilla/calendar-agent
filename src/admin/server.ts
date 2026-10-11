import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from '../config/env.js';
import type { Repositories } from '../db/index.js';
import type { Logger } from '../logging/logger.js';
import type { Services } from '../services/pipeline-factory.js';
import { PasswordVerifier, readSession } from './auth.js';
import { SECURITY_HEADERS } from './headers.js';
import { page } from './html.js';
import { registerLoginRoutes } from './routes/login.js';
import { registerQueriesRoutes } from './routes/queries.js';
import { registerSandboxRoutes } from './routes/sandbox.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerWorkspacesRoutes } from './routes/workspaces.js';
import type { RuntimeStatus } from './status.js';

export interface AdminDeps {
  /** Login limiter per connecting socket; the default is 20 per minute (tests lower it to exercise the page). */
  loginRateLimit?: { max: number; timeWindow: string };
  config: AppConfig;
  log: Logger;
  repos: Repositories;
  services: Services;
  status: RuntimeStatus;
  /** Extra routes mounted before the admin pages (the Slack OAuth installer in multi mode). */
  extraRoutes?: ((app: FastifyInstance) => Promise<void> | void) | undefined;
}

/**
 * The HTTP server: health, admin pages, sandbox, and (multi mode) the Slack
 * install routes. Security headers on every response; sessions from a cookie;
 * CSRF on every state-changing form; login rate-limited and locked out.
 */
export async function createAdminServer(deps: AdminDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyStatic, { root: fileURLToPath(new URL('./static/', import.meta.url)), prefix: '/static/', decorateReply: false, cacheControl: false, dotfiles: 'ignore' });

  const verifier = new PasswordVerifier(deps.config.ADMIN_PASSWORD);

  app.addHook('onSend', async (req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    // Only meaningful on the HTTPS (Tailscale Serve) origin; harmless elsewhere (R4-9).
    if (req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000');
  });

  app.addHook('onRequest', async (req) => {
    req.auth = readSession(req, deps.repos.sessions);
    req.csrfField = '';
  });

  // Public: liveness and the two numbers `make status` needs; the identity
  // fields only for a logged-in admin (R4-9).
  app.get('/health', async (req) => {
    const base = { ok: true, slackConnected: deps.status.slackConnected, workspaces: deps.repos.installations.list().length, time: new Date().toISOString() };
    return req.auth.session ? { ...base, app: 'calendar-agent', botName: deps.config.botName, installMode: deps.config.installMode } : base;
  });

  registerLoginRoutes(app, deps, verifier);
  if (deps.extraRoutes) await deps.extraRoutes(app);
  registerQueriesRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerWorkspacesRoutes(app, deps);
  registerSandboxRoutes(app, deps);

  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'not_found' }));
  app.setErrorHandler(async (err: Error & { statusCode?: number }, req, reply) => {
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (code === 500) deps.log.error({ err: { name: err.name, message: err.message }, path: req.url }, 'request failed');
    if (code === 429) {
      return reply.code(429).type('text/html').send(page({ title: 'Too many requests', botName: deps.config.botName, authenticated: false, flash: { kind: 'error', text: 'Too many attempts. Please wait a minute and try again.' }, body: '<p><a href="/login">Back to login</a></p>' }));
    }
    reply.code(code).send({ error: code === 500 ? 'internal' : err.name });
  });
  return app;
}
