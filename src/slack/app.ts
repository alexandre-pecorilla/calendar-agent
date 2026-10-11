import { App, SocketModeReceiver } from '@slack/bolt';
import type { Logger as SlackLogger } from '@slack/logger';
import { LogLevel } from '@slack/logger';
import type { Logger } from '../logging/logger.js';
import { createAuthorize } from './authorize.js';
import { handleDirectMessage, handleMention, handleSlashCommand, type HandlerDeps, type MessageEventLike, type SlashCommandLike } from './handlers.js';

/**
 * Bolt's logger interface on top of pino, capped at INFO whatever `LOG_LEVEL`
 * says: at debug the Slack libraries print whole event payloads (question text
 * included), so their debug output is discarded here rather than filtered by
 * level (R4-3). Info, warn and error carry ids and error names only.
 */
export function boltLogger(log: Logger): SlackLogger {
  return {
    debug: () => {},
    info: (...m: unknown[]) => log.info({ bolt: m.map(String).join(' ') }),
    warn: (...m: unknown[]) => log.warn({ bolt: m.map(String).join(' ') }),
    error: (...m: unknown[]) => log.error({ bolt: m.map(String).join(' ') }),
    setLevel: () => {},
    getLevel: () => LogLevel.INFO,
    setName: () => {},
  };
}

export interface SlackRuntime {
  app: App;
  stop: () => Promise<void>;
}

/** The subset of the Socket Mode client the status wiring needs (an EventEmitter). */
export interface SocketStateSource {
  on: (event: string, listener: () => void) => unknown;
}

/**
 * Mirrors the Socket Mode connection state into the runtime status (R2-3).
 * With auto-reconnect the client emits `reconnecting` (not `disconnected`)
 * when the socket is lost unexpectedly, so every non-connected state clears
 * the flag and records when the socket was lost.
 */
export function wireSocketStatus(client: SocketStateSource, status: HandlerDeps['status'], log: Logger, now: () => Date = () => new Date()): void {
  const lost = (state: string) => () => {
    if (status.slackConnected) status.slackDisconnectedAt = now().toISOString();
    status.slackConnected = false;
    log.warn({ state }, 'slack socket mode not connected');
  };
  client.on('connected', () => {
    status.slackConnected = true;
    status.slackDisconnectedAt = null;
    log.info('slack socket mode connected');
  });
  for (const state of ['disconnected', 'disconnecting', 'reconnecting']) client.on(state, lost(state));
}

/**
 * Socket Mode app: one WebSocket for every workspace; the bot token per
 * workspace comes from the encrypted store through `authorize`. No inbound
 * HTTP for events. The connection state is mirrored into the runtime status
 * for the admin and /health.
 */
export async function startSlack(deps: HandlerDeps): Promise<SlackRuntime> {
  const { config, log, status } = deps;
  const receiver = new SocketModeReceiver({ appToken: config.SLACK_APP_TOKEN, logger: boltLogger(log), autoReconnectEnabled: true });
  const app = new App({ receiver, authorize: createAuthorize(deps.repos.installations), logger: boltLogger(log), ignoreSelf: true });

  wireSocketStatus(receiver.client as unknown as SocketStateSource, status, log);

  app.message(async ({ message, say, client, context }) => {
    await handleDirectMessage(deps, { event: message as unknown as MessageEventLike, teamId: context.teamId ?? null, client, say });
  });
  app.event('app_mention', async ({ event, say, client, context }) => {
    await handleMention(deps, { event: event as unknown as MessageEventLike, teamId: context.teamId ?? null, client, say });
  });
  app.command(config.slashCommand, async ({ command, ack, respond, client }) => {
    await handleSlashCommand(deps, { command: command as unknown as SlashCommandLike, ack: ack as never, respond: respond as never, client });
  });
  app.error(async (err) => {
    log.error({ err: err.name, code: (err as { code?: string }).code }, 'bolt error');
  });

  await app.start();
  log.info({ slashCommand: config.slashCommand }, 'slack app started');
  return {
    app,
    stop: async () => {
      await app.stop();
    },
  };
}
