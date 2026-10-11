import type { Installation, InstallationQuery, InstallationStore } from '@slack/oauth';
import type { InstallationsRepository } from '../db/repos/installations.js';
import type { Logger } from '../logging/logger.js';

/**
 * `@slack/oauth` installation store backed by the encrypted
 * `slack_installations` table. Bot tokens only; org-wide installs refused.
 */
export class SqliteInstallationStore implements InstallationStore {
  constructor(
    private readonly repo: InstallationsRepository,
    private readonly log: Logger,
  ) {}

  async storeInstallation(installation: Installation<'v1' | 'v2', boolean>): Promise<void> {
    if (installation.isEnterpriseInstall) throw new Error('Organisation-wide installations are not supported.');
    const teamId = installation.team?.id;
    const token = installation.bot?.token;
    if (!teamId || !token) throw new Error('Installation without a team id or bot token.');
    this.repo.upsert({
      teamId,
      teamName: installation.team?.name ?? null,
      enterpriseId: installation.enterprise?.id ?? null,
      botToken: token,
      botId: installation.bot?.id ?? null,
      botUserId: installation.bot?.userId ?? null,
      scopes: installation.bot?.scopes ?? [],
      installedBy: installation.user?.id ?? null,
    });
    this.log.info({ teamId, teamName: installation.team?.name ?? null }, 'slack workspace installed');
  }

  async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation<'v1' | 'v2', boolean>> {
    if (query.isEnterpriseInstall || !query.teamId) throw new Error('Organisation-wide installations are not supported.');
    const inst = this.repo.get(query.teamId);
    if (!inst) throw new Error(`No installation for workspace ${query.teamId}.`);
    return {
      team: { id: inst.teamId, name: inst.teamName ?? undefined },
      enterprise: undefined,
      user: { id: inst.installedBy ?? '', token: undefined, scopes: undefined },
      bot: { token: inst.botToken.reveal(), scopes: inst.scopes, id: inst.botId ?? '', userId: inst.botUserId ?? '' },
      tokenType: 'bot',
      isEnterpriseInstall: false,
      authVersion: 'v2',
    } as Installation<'v2', false>;
  }

  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    if (query.teamId) this.repo.remove(query.teamId);
  }
}
