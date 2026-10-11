import type { DateTime } from 'luxon';
import type { QueriesRepository } from '../db/repos/queries.js';
import type { SettingsRepository } from '../db/repos/settings.js';

export type LimitVerdict = 'rate_limited' | 'over_capacity' | null;

/**
 * Abuse limits (scope §6.6), computed from the query log so they survive a
 * restart: per user and per workspace and globally per minute, and a daily
 * budget. Sandbox and CLI questions never count.
 */
export function checkLimits(
  queries: QueriesRepository,
  settings: SettingsRepository,
  ctx: { userId: string; workspaceId: string | null; now: DateTime },
): LimitVerdict {
  const minuteAgo = ctx.now.minus({ minutes: 1 }).toUTC().toISO()!;
  const dayStart = ctx.now.toUTC().startOf('day').toISO()!;
  if (queries.countSince(dayStart) >= settings.getNumber('daily_budget')) return 'over_capacity';
  if (queries.countUserSince(ctx.userId, minuteAgo) >= settings.getNumber('rate_user_per_minute')) return 'rate_limited';
  if (ctx.workspaceId && queries.countWorkspaceSince(ctx.workspaceId, minuteAgo) >= settings.getNumber('rate_workspace_per_minute')) return 'rate_limited';
  if (queries.countSince(minuteAgo) >= settings.getNumber('rate_global_per_minute')) return 'rate_limited';
  return null;
}
