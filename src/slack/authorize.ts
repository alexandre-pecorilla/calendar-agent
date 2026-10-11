import type { Authorize } from '@slack/bolt';
import type { InstallationsRepository } from '../db/repos/installations.js';

/** Bolt `authorize`: the bot token for the workspace an event came from, from the encrypted store. */
export function createAuthorize(repo: InstallationsRepository): Authorize<boolean> {
  return async (source) => {
    if (source.isEnterpriseInstall) throw new Error('Organisation-wide installations are not supported.');
    const teamId = source.teamId;
    if (!teamId) throw new Error('Event without a team id.');
    const inst = repo.get(teamId);
    if (!inst) throw new Error(`Workspace ${teamId} is not installed.`);
    return {
      botToken: inst.botToken.reveal(),
      teamId: inst.teamId,
      ...(inst.botId ? { botId: inst.botId } : {}),
      ...(inst.botUserId ? { botUserId: inst.botUserId } : {}),
    };
  };
}

export interface AuthTestResult {
  team_id?: string;
  team?: string;
  user_id?: string;
  bot_id?: string;
  enterprise_id?: string;
}

/**
 * Seed the store from `SLACK_BOT_TOKEN` (single mode, or the home workspace in
 * multi mode) using `auth.test` for the team id. A workspace already in the
 * store is left alone, so a token rotated through the installer is never
 * overwritten by a stale env value.
 */
export async function seedInstallationFromToken(
  repo: InstallationsRepository,
  botToken: string,
  authTest: (token: string) => Promise<AuthTestResult>,
  scopes: readonly string[],
): Promise<{ teamId: string; teamName: string | null; seeded: boolean }> {
  const r = await authTest(botToken);
  if (!r.team_id) throw new Error('auth.test returned no team id for SLACK_BOT_TOKEN.');
  const existing = repo.get(r.team_id);
  if (existing) return { teamId: r.team_id, teamName: existing.teamName, seeded: false };
  repo.upsert({
    teamId: r.team_id,
    teamName: r.team ?? null,
    enterpriseId: r.enterprise_id ?? null,
    botToken,
    botId: r.bot_id ?? null,
    botUserId: r.user_id ?? null,
    scopes: [...scopes],
    installedBy: 'env',
  });
  return { teamId: r.team_id, teamName: r.team ?? null, seeded: true };
}
