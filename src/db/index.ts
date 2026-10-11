import type { MasterKey } from '../crypto/envelope.js';
import { runMigrations } from './migrate.js';
import { InstallationsRepository } from './repos/installations.js';
import { QueriesRepository } from './repos/queries.js';
import { SessionsRepository } from './repos/sessions.js';
import { SettingsRepository } from './repos/settings.js';
import { SlackUsersRepository } from './repos/slack-users.js';
import { openDatabase, type Database } from './sqlite.js';

export interface Repositories {
  db: Database;
  /** Migrations applied and skipped at this boot (logged, R2-13). */
  migrations: { applied: string[]; skipped: string[] };
  settings: SettingsRepository;
  queries: QueriesRepository;
  installations: InstallationsRepository;
  sessions: SessionsRepository;
  slackUsers: SlackUsersRepository;
}

/** Open, migrate, and build every repository. `:memory:` for tests. */
export function createRepositories(dataDir: string, master: MasterKey, migrationsDir?: string): Repositories {
  const db = openDatabase(dataDir);
  const migrations = runMigrations(db, migrationsDir);
  return {
    db,
    migrations,
    settings: new SettingsRepository(db, master),
    queries: new QueriesRepository(db),
    installations: new InstallationsRepository(db, master),
    sessions: new SessionsRepository(db),
    slackUsers: new SlackUsersRepository(db),
  };
}
