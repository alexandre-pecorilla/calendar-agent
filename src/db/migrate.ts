import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database } from './sqlite.js';

/**
 * Numbered SQL migrations applied in order, each in its own transaction and
 * recorded in `schema_migrations`. Re-running is a no-op. A failing migration
 * rolls back and leaves the record untouched.
 */
export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('./migrations/', import.meta.url));
}

export function runMigrations(db: Database, dir = defaultMigrationsDir()): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map((r) => r.name),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const result: MigrationResult = { applied: [], skipped: [] };
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const file of files) {
    if (done.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const sql = readFileSync(new URL(file, `file://${dir}`), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      record.run(file, new Date().toISOString());
      db.exec('COMMIT');
      result.applied.push(file);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return result;
}
