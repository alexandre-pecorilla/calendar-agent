import type { AppConfig } from '../config/env.js';
import type { Repositories } from '../db/index.js';
import type { Logger } from '../logging/logger.js';
import type { AnswerPipeline } from '../pipeline/answer.js';
import { fixedReply } from '../pipeline/fixed-replies.js';
import type { RuntimeStatus } from '../admin/status.js';
import { getAskerContext } from './user-context.js';
import type { WebClient } from '@slack/web-api';

/**
 * The three Slack entry points (scope §4), written as plain functions so
 * tests drive them with synthetic payloads and fakes. Each one: resolve the
 * asker's timezone and locale, run the single pipeline, deliver the reply the
 * way Slack recommends for that surface. Errors never propagate to Bolt.
 */
export interface HandlerDeps {
  config: AppConfig;
  repos: Repositories;
  pipeline: AnswerPipeline;
  status: RuntimeStatus;
  log: Logger;
}

export interface MessageEventLike {
  type: string;
  subtype?: string | undefined;
  channel: string;
  channel_type?: string | undefined;
  user?: string | undefined;
  text?: string | undefined;
  ts: string;
  thread_ts?: string | undefined;
  bot_id?: string | undefined;
}

export interface SlashCommandLike {
  command: string;
  text?: string | undefined;
  user_id: string;
  channel_id: string;
  team_id?: string | undefined;
}

type Say = (msg: { text: string; thread_ts?: string }) => Promise<unknown>;
type Respond = (msg: { text: string; response_type: 'ephemeral'; replace_original?: boolean }) => Promise<unknown>;

function workspaceName(deps: HandlerDeps, teamId: string | null): string | null {
  return teamId ? (deps.repos.installations.get(teamId)?.teamName ?? null) : null;
}

async function answer(deps: HandlerDeps, args: { client: Pick<WebClient, 'users'>; teamId: string | null; userId: string; channelId: string; entryPoint: 'dm' | 'mention' | 'slash'; text: string }): Promise<string> {
  deps.status.slackLastEventAt = new Date().toISOString();
  const asker = args.teamId ? await getAskerContext(args.client, deps.repos.slackUsers, args.teamId, args.userId, deps.log) : { tz: null, locale: null, name: null };
  try {
    const result = await deps.pipeline.ask(
      { userId: args.userId, userName: asker.name, workspaceId: args.teamId, workspaceName: workspaceName(deps, args.teamId), entryPoint: args.entryPoint, channelId: args.channelId, askerTz: asker.tz, askerLocale: asker.locale },
      args.text,
    );
    return result.text;
  } catch (err) {
    deps.log.error({ err: (err as Error).name, entryPoint: args.entryPoint }, 'pipeline threw');
    return fixedReply('cannot_check', /^fr/i.test(asker.locale ?? '') ? 'fr' : 'en', { ownerName: deps.config.ownerName, botName: deps.config.botName });
  }
}

/** A direct message to the bot: plain reply in the DM. Bot messages and edits are ignored. */
export async function handleDirectMessage(deps: HandlerDeps, a: { event: MessageEventLike; teamId: string | null; client: Pick<WebClient, 'users'>; say: Say }): Promise<boolean> {
  const e = a.event;
  if (e.channel_type !== 'im' || e.subtype || e.bot_id || !e.user) return false;
  const text = await answer(deps, { client: a.client, teamId: a.teamId, userId: e.user, channelId: e.channel, entryPoint: 'dm', text: e.text ?? '' });
  await a.say({ text });
  return true;
}

/** An @mention in a channel: reply in the thread under the message (`thread_ts ?? ts`). */
export async function handleMention(deps: HandlerDeps, a: { event: MessageEventLike; teamId: string | null; client: Pick<WebClient, 'users'>; say: Say }): Promise<boolean> {
  const e = a.event;
  if (e.bot_id || !e.user) return false;
  const text = await answer(deps, { client: a.client, teamId: a.teamId, userId: e.user, channelId: e.channel, entryPoint: 'mention', text: e.text ?? '' });
  await a.say({ text, thread_ts: e.thread_ts ?? e.ts });
  return true;
}

/** The slash command: acknowledged at once with a placeholder, then the ephemeral answer replaces it. */
export async function handleSlashCommand(deps: HandlerDeps, a: { command: SlashCommandLike; ack: (msg?: { text: string; response_type: 'ephemeral' }) => Promise<unknown>; respond: Respond; client: Pick<WebClient, 'users'> }): Promise<void> {
  await a.ack({ text: '…', response_type: 'ephemeral' });
  const text = await answer(deps, { client: a.client, teamId: a.command.team_id ?? null, userId: a.command.user_id, channelId: a.command.channel_id, entryPoint: 'slash', text: a.command.text ?? '' });
  await a.respond({ text, response_type: 'ephemeral', replace_original: true });
}
