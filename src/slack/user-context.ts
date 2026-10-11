import type { WebClient } from '@slack/web-api';
import type { SlackUsersRepository } from '../db/repos/slack-users.js';
import type { Logger } from '../logging/logger.js';

export const USER_CACHE_MS = 3_600_000;

export interface AskerContext {
  tz: string | null;
  locale: string | null;
  name: string | null;
}

/** The asker's timezone, locale and display name from `users.info`, cached one hour. Failures degrade to nulls (owner zone, English). */
export async function getAskerContext(
  client: Pick<WebClient, 'users'>,
  cache: SlackUsersRepository,
  teamId: string,
  userId: string,
  log: Logger,
  now: Date = new Date(),
): Promise<AskerContext> {
  const cached = cache.get(teamId, userId, USER_CACHE_MS, now);
  if (cached) return { tz: cached.tz, locale: cached.locale, name: cached.name };
  try {
    const res = await client.users.info({ user: userId, include_locale: true });
    const u = res.user as { tz?: string; locale?: string; real_name?: string; name?: string; profile?: { display_name?: string } } | undefined;
    const ctx: AskerContext = { tz: u?.tz ?? null, locale: u?.locale ?? null, name: u?.profile?.display_name || u?.real_name || u?.name || null };
    cache.set(teamId, userId, ctx, now);
    return ctx;
  } catch (err) {
    log.warn({ teamId, err: (err as Error).name }, 'users.info failed; using owner zone');
    return { tz: null, locale: null, name: null };
  }
}
