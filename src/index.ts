import { loadConfig, ConfigError } from './config/env.js';
import { createLogger } from './logging/logger.js';
import { syncPasswordFingerprint } from './admin/auth.js';
import { createAdminServer } from './admin/server.js';
import { parseMasterKey } from './crypto/envelope.js';
import { createRepositories } from './db/index.js';
import { seedSecretsFromEnv } from './db/repos/settings.js';
import { createServices } from './services/pipeline-factory.js';
import { createStatus } from './admin/status.js';
import { registerInstallRoutes } from './slack/install-routes.js';
import { seedInstallationFromToken } from './slack/authorize.js';
import { startSlack } from './slack/app.js';
import { BOT_SCOPES } from './slack/scopes.js';
import { WebClient } from '@slack/web-api';

/**
 * Boot order: config → logger → admin HTTP (health) → (later steps) database,
 * services, Slack. A configuration error stops the process with the variable
 * name only.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  const log = createLogger(config.LOG_LEVEL);
  log.info({ botName: config.botName, installMode: config.installMode, port: config.APP_PORT }, 'starting');

  let master;
  try {
    master = parseMasterKey(config.MASTER_KEY);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const repos = createRepositories(config.DATA_DIR, master);
  const seeded = seedSecretsFromEnv(repos.settings, config);
  log.info({ dataDir: config.DATA_DIR, migrations: repos.migrations, seeded, sessionsPurged: repos.sessions.purgeExpired() }, 'database ready');
  const staleSettings = repos.settings.unreadable();
  const staleWorkspaces = repos.installations.unreadable();
  if (staleSettings.length || staleWorkspaces.length) {
    log.warn(
      { settings: staleSettings.map((s) => s.key), workspaces: staleWorkspaces.map((w) => w.teamId) },
      'rows encrypted with a previous MASTER_KEY cannot be read: paste the provider keys again in Settings, re-install or remove the workspaces (docs/development/release.md)',
    );
  }
  const fingerprint = syncPasswordFingerprint(repos.settings, repos.sessions, master, config.ADMIN_PASSWORD);
  if (fingerprint.changed) log.info({ sessionsCleared: fingerprint.sessionsCleared }, 'ADMIN_PASSWORD changed since the last start: every admin session ended');

  const services = createServices(config, repos, log);
  const status = createStatus();

  const server = await createAdminServer({
    config,
    log,
    repos,
    services,
    status,
    extraRoutes: (app) => registerInstallRoutes(app, { config, repos, log }),
  });
  await server.listen({ port: config.APP_PORT, host: config.APP_HOST });
  log.info({ host: config.APP_HOST, port: config.APP_PORT }, 'http listening');

  // Signal handlers as soon as the server listens, before any network step that
  // may take long (R2-9); a second signal during shutdown is ignored.
  let slack: Awaited<ReturnType<typeof startSlack>> | null = null;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    try {
      await slack?.stop();
      await server.close();
      repos.db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (config.slackEnabled) {
    if (config.SLACK_BOT_TOKEN) {
      try {
        const seeded = await seedInstallationFromToken(repos.installations, config.SLACK_BOT_TOKEN, async (token) => (await new WebClient(token, { retryConfig: { retries: 2, factor: 2, minTimeout: 500 } }).auth.test()) as never, BOT_SCOPES);
        log.info({ teamId: seeded.teamId, teamName: seeded.teamName, seeded: seeded.seeded }, 'slack home workspace');
        const otherEnvRows = repos.installations.list().filter((i) => i.installedBy === 'env' && i.teamId !== seeded.teamId);
        if (otherEnvRows.length) log.warn({ teams: otherEnvRows.map((i) => i.teamId) }, 'SLACK_BOT_TOKEN now belongs to another workspace; stale env-seeded rows remain (remove them in the admin)');
      } catch (err) {
        log.error({ err: (err as Error).message }, 'SLACK_BOT_TOKEN seeding failed');
      }
    }
    try {
      slack = await startSlack({ config, repos, pipeline: services.pipeline, status, log });
    } catch (err) {
      log.error({ err: (err as Error).message }, 'slack failed to start; admin and sandbox keep running');
    }
  } else {
    log.warn('SLACK_ENABLED=false: Slack is off, admin and sandbox only');
  }

}

main().catch((err) => {
  console.error('fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
