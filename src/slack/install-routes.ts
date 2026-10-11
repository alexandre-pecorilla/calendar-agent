import type { FastifyInstance } from 'fastify';
import { InstallProvider } from '@slack/oauth';
import { requireSession } from '../admin/auth.js';
import { applySecurityHeaders } from '../admin/headers.js';
import { esc, page } from '../admin/html.js';
import type { AppConfig } from '../config/env.js';
import type { Repositories } from '../db/index.js';
import type { Logger } from '../logging/logger.js';
import { boltLogger } from './app.js';
import { SqliteInstallationStore } from './installation-store.js';
import { BOT_SCOPES } from './scopes.js';

/**
 * Multi-mode installer (the an earlier internal project pattern, scope §9): `/slack/install` starts
 * Slack's OAuth flow for another workspace (admin session required),
 * `/slack/oauth_redirect` receives the code (Slack redirects the installer's
 * browser here; no session, state verified by `@slack/oauth`), exchanges it
 * and stores the bot token encrypted.
 *
 * The state lives in a `Secure`, host-only cookie set by `@slack/oauth`, so the
 * flow must start on the HTTPS origin of `PUBLIC_BASE_URL` (R2-1): an install
 * request arriving on any other origin is redirected there first.
 */
export function installUrl(config: AppConfig): string | null {
  return config.PUBLIC_BASE_URL ? `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/slack/install` : null;
}

/** The Slack-side reason of a failed code exchange, when the library wrapped one (R2-5). */
export function slackErrorDetail(error: unknown): string | null {
  const data = (error as { data?: { error?: unknown } }).data;
  return data && typeof data.error === 'string' ? data.error : null;
}

export function registerInstallRoutes(app: FastifyInstance, deps: { config: AppConfig; repos: Repositories; log: Logger }): void {
  const { config } = deps;
  if (config.installMode !== 'multi' || !config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET || !config.SLACK_STATE_SECRET || !config.PUBLIC_BASE_URL) return;
  const base = new URL(config.PUBLIC_BASE_URL);
  const redirectUri = `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/slack/oauth_redirect`;
  const installer = new InstallProvider({
    clientId: config.SLACK_CLIENT_ID,
    clientSecret: config.SLACK_CLIENT_SECRET,
    stateSecret: config.SLACK_STATE_SECRET,
    installationStore: new SqliteInstallationStore(deps.repos.installations, deps.log),
    directInstall: true,
    installUrlOptions: { scopes: [...BOT_SCOPES], redirectUri },
    logger: boltLogger(deps.log),
  });

  app.get('/slack/install', { preHandler: requireSession }, async (req, reply) => {
    // Cookies ignore the port, so the host name and HTTPS are what matter.
    const sameOrigin = req.protocol === 'https' && req.hostname.toLowerCase() === base.hostname.toLowerCase();
    if (!sameOrigin) return reply.redirect(installUrl(config)!);
    reply.hijack();
    applySecurityHeaders(reply.raw);
    await installer.handleInstallPath(req.raw, reply.raw);
  });

  app.get('/slack/oauth_redirect', async (req, reply) => {
    reply.hijack();
    applySecurityHeaders(reply.raw);
    await installer.handleCallback(req.raw, reply.raw, {
      successAsync: async (installation, _opts, _r, res) => {
        const name = installation.team?.name ?? installation.team?.id ?? 'workspace';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page({ title: 'Connected', botName: config.botName, authenticated: false, body: `<h1>Workspace connected</h1><p><strong>${esc(name)}</strong> can now ask ${esc(config.botName)}. <a href="/workspaces">Back to Workspaces</a></p>` }));
      },
      failureAsync: async (error, _opts, _r, res) => {
        const detail = slackErrorDetail(error);
        const code = error.code ?? error.name;
        deps.log.warn({ code, detail }, 'slack install failed');
        const hints: string[] = [];
        if (code === 'slack_oauth_invalid_state') hints.push(`Start the install from <a href="${esc(installUrl(config)!)}">${esc(installUrl(config)!)}</a> (the HTTPS address): the state cookie is bound to it. On a phone the page may also load twice; the first load may have succeeded, check <a href="/workspaces">Workspaces</a>.`);
        if (detail === 'bad_client_secret' || detail === 'invalid_client_id') hints.push('The client secret in .env does not match the Slack app: regenerate it under Basic Information, update .env, <code>make restart</code>. Existing workspaces keep working.');
        if (detail === 'invalid_code' || detail === 'code_already_used') hints.push('The code expired or was already used (a reloaded callback): start again from Workspaces → Add to Slack.');
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page({ title: 'Install failed', botName: config.botName, authenticated: false, body: `<h1>Install failed</h1><p>Slack reported <code>${esc(code)}</code>${detail ? ` (<code>${esc(detail)}</code>)` : ''}.</p>${hints.map((h) => `<p>${h}</p>`).join('')}<p><a href="/workspaces">Back to Workspaces</a></p>` }));
      },
    });
  });
}
