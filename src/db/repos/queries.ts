import { nowIso, type Database } from '../sqlite.js';

export type EntryPoint = 'dm' | 'mention' | 'slash' | 'sandbox' | 'cli';

export interface QueryRecord {
  id?: number;
  received_at?: string;
  workspace_id: string | null;
  workspace_name: string | null;
  user_id: string;
  user_name: string | null;
  entry_point: EntryPoint;
  channel_id: string | null;
  question: string;
  intent: string | null;
  parsed_json: string | null;
  answer: string | null;
  language: string | null;
  timezone_used: string | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
}

export interface QueryFilter {
  workspaceId?: string | undefined;
  userId?: string | undefined;
  entryPoint?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

const COUNTED_SQL = `AND entry_point IN ('dm','mention','slash') AND (intent IS NULL OR intent NOT IN ('rate_limited','over_capacity'))`;

/** The query log (scope §10/§11). Kept forever by decision D9. */
export class QueriesRepository {
  constructor(private readonly db: Database) {}

  insert(q: QueryRecord): number {
    const res = this.db
      .prepare(
        `INSERT INTO queries (received_at, workspace_id, workspace_name, user_id, user_name, entry_point, channel_id,
           question, intent, parsed_json, answer, language, timezone_used, latency_ms, prompt_tokens, completion_tokens, cost_usd, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        q.received_at ?? nowIso(),
        q.workspace_id,
        q.workspace_name,
        q.user_id,
        q.user_name,
        q.entry_point,
        q.channel_id,
        q.question,
        q.intent,
        q.parsed_json,
        q.answer,
        q.language,
        q.timezone_used,
        q.latency_ms,
        q.prompt_tokens,
        q.completion_tokens,
        q.cost_usd,
        q.error,
      );
    return Number(res.lastInsertRowid);
  }

  get(id: number): QueryRecord | null {
    return (this.db.prepare('SELECT * FROM queries WHERE id = ?').get(id) as QueryRecord | undefined) ?? null;
  }

  list(filter: QueryFilter = {}): { rows: QueryRecord[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.workspaceId) {
      where.push('workspace_id = ?');
      params.push(filter.workspaceId);
    }
    if (filter.userId) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.entryPoint) {
      where.push('entry_point = ?');
      params.push(filter.entryPoint);
    }
    if (filter.from) {
      where.push('received_at >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      where.push('received_at <= ?');
      params.push(filter.to);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM queries ${clause}`).get(...params) as { n: number }).n;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Number.isSafeInteger(filter.offset) ? Math.max(filter.offset as number, 0) : 0;
    const rows = this.db
      .prepare(`SELECT * FROM queries ${clause} ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as QueryRecord[];
    return { rows, total };
  }

  /**
   * Counts used by the abuse limits; sandbox and CLI never count, and a
   * question refused by a limit cost nothing, so it does not count either (R1-11).
   */
  countUserSince(userId: string, sinceIso: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM queries WHERE user_id = ? AND received_at >= ? ${COUNTED_SQL}`)
        .get(userId, sinceIso) as { n: number }
    ).n;
  }

  countWorkspaceSince(workspaceId: string, sinceIso: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM queries WHERE workspace_id = ? AND received_at >= ? ${COUNTED_SQL}`)
        .get(workspaceId, sinceIso) as { n: number }
    ).n;
  }

  countSince(sinceIso: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM queries WHERE received_at >= ? ${COUNTED_SQL}`)
        .get(sinceIso) as { n: number }
    ).n;
  }

  distinctWorkspaces(): Array<{ workspace_id: string; workspace_name: string | null }> {
    return this.db
      .prepare('SELECT DISTINCT workspace_id, workspace_name FROM queries WHERE workspace_id IS NOT NULL ORDER BY workspace_name')
      .all() as Array<{ workspace_id: string; workspace_name: string | null }>;
  }

  distinctUsers(): Array<{ user_id: string; user_name: string | null }> {
    return this.db
      .prepare('SELECT DISTINCT user_id, user_name FROM queries ORDER BY user_name')
      .all() as Array<{ user_id: string; user_name: string | null }>;
  }
}
