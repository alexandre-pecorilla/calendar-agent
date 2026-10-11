import { type Database } from '../sqlite.js';

export interface CachedSlackUser {
  tz: string | null;
  locale: string | null;
  name: string | null;
  fetchedAt: string;
}

/** `users.info` results, cached one hour (scope: asker timezone and locale). */
export class SlackUsersRepository {
  constructor(private readonly db: Database) {}

  get(teamId: string, userId: string, maxAgeMs: number, now: Date = new Date()): CachedSlackUser | null {
    const row = this.db.prepare('SELECT tz, locale, name, fetched_at FROM slack_user_cache WHERE team_id = ? AND user_id = ?').get(teamId, userId) as
      | { tz: string | null; locale: string | null; name: string | null; fetched_at: string }
      | undefined;
    if (!row) return null;
    if (now.getTime() - new Date(row.fetched_at).getTime() > maxAgeMs) return null;
    return { tz: row.tz, locale: row.locale, name: row.name, fetchedAt: row.fetched_at };
  }

  set(teamId: string, userId: string, u: { tz: string | null; locale: string | null; name: string | null }, now: Date = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO slack_user_cache (team_id, user_id, tz, locale, name, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, user_id) DO UPDATE SET tz = excluded.tz, locale = excluded.locale, name = excluded.name, fetched_at = excluded.fetched_at`,
      )
      .run(teamId, userId, u.tz, u.locale, u.name, now.toISOString());
  }
}
