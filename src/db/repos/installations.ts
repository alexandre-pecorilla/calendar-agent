import { ciphertextKeyId, decrypt, DecryptionError, encrypt, type MasterKey } from '../../crypto/envelope.js';
import { Secret } from '../../crypto/secret.js';
import { nowIso, type Database } from '../sqlite.js';

export interface InstallationInput {
  teamId: string;
  teamName: string | null;
  enterpriseId: string | null;
  botToken: string;
  botId: string | null;
  botUserId: string | null;
  scopes: string[];
  installedBy: string | null;
}

export interface Installation {
  teamId: string;
  teamName: string | null;
  enterpriseId: string | null;
  botToken: Secret;
  botId: string | null;
  botUserId: string | null;
  scopes: string[];
  installedBy: string | null;
  installedAt: string;
}

interface Row {
  team_id: string;
  team_name: string | null;
  enterprise_id: string | null;
  bot_token_enc: string;
  bot_id: string | null;
  bot_user_id: string | null;
  scopes: string | null;
  installed_by: string | null;
  installed_at: string;
  removed_at: string | null;
}

/** One row per workspace; the bot token is envelope-encrypted with the team id as AAD. */
export class InstallationsRepository {
  constructor(
    private readonly db: Database,
    private readonly master: MasterKey,
  ) {}

  upsert(i: InstallationInput): void {
    this.db
      .prepare(
        `INSERT INTO slack_installations (team_id, team_name, enterprise_id, bot_token_enc, bot_id, bot_user_id, scopes, installed_by, installed_at, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(team_id) DO UPDATE SET team_name = excluded.team_name, enterprise_id = excluded.enterprise_id,
           bot_token_enc = excluded.bot_token_enc, bot_id = excluded.bot_id, bot_user_id = excluded.bot_user_id,
           scopes = excluded.scopes, installed_by = excluded.installed_by, installed_at = excluded.installed_at, removed_at = NULL`,
      )
      .run(i.teamId, i.teamName, i.enterpriseId, encrypt(this.master, i.botToken, i.teamId), i.botId, i.botUserId, i.scopes.join(','), i.installedBy, nowIso());
  }

  /** The workspace, or null when absent or when its token was encrypted with a previous master key (R3-1). */
  get(teamId: string): Installation | null {
    const row = this.db.prepare('SELECT * FROM slack_installations WHERE team_id = ? AND removed_at IS NULL').get(teamId) as Row | undefined;
    return row ? this.tryInstallation(row) : null;
  }

  /** Readable active workspaces; see `unreadable()` for the rest. */
  list(): Installation[] {
    const rows = this.db.prepare('SELECT * FROM slack_installations WHERE removed_at IS NULL ORDER BY installed_at').all() as unknown as Row[];
    return rows.flatMap((r) => {
      const i = this.tryInstallation(r);
      return i ? [i] : [];
    });
  }

  /** Active rows whose token the current master key cannot read (after a MASTER_KEY change). */
  unreadable(): Array<{ teamId: string; teamName: string | null; installedBy: string | null; keyId: string | null }> {
    const rows = this.db.prepare('SELECT * FROM slack_installations WHERE removed_at IS NULL ORDER BY installed_at').all() as unknown as Row[];
    return rows.filter((r) => !this.tryInstallation(r)).map((r) => ({ teamId: r.team_id, teamName: r.team_name, installedBy: r.installed_by, keyId: ciphertextKeyId(r.bot_token_enc) }));
  }

  remove(teamId: string): boolean {
    const res = this.db.prepare('UPDATE slack_installations SET removed_at = ? WHERE team_id = ? AND removed_at IS NULL').run(nowIso(), teamId);
    return res.changes > 0;
  }

  private tryInstallation(r: Row): Installation | null {
    try {
      return this.toInstallation(r);
    } catch (err) {
      if (err instanceof DecryptionError) return null;
      throw err;
    }
  }

  private toInstallation(r: Row): Installation {
    return {
      teamId: r.team_id,
      teamName: r.team_name,
      enterpriseId: r.enterprise_id,
      botToken: new Secret(decrypt(this.master, r.bot_token_enc, r.team_id)),
      botId: r.bot_id,
      botUserId: r.bot_user_id,
      scopes: r.scopes ? r.scopes.split(',').filter(Boolean) : [],
      installedBy: r.installed_by,
      installedAt: r.installed_at,
    };
  }
}
