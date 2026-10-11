import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { rmSync } from 'node:fs';

export type Database = DatabaseSync;

export const DB_FILENAME = 'calendar-agent.db';

/**
 * Open (or create) the SQLite database with Node's built-in driver. No native
 * build, no extra dependency. WAL for concurrent reads, foreign keys on, a busy
 * timeout so a backup never fails a write.
 */
export function openDatabase(dataDir: string): Database {
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });
  const path = dataDir === ':memory:' ? ':memory:' : join(dataDir, DB_FILENAME);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

/** Consistent snapshot copy via SQLite's online backup API, usable while the app runs. */
export async function backupDatabase(db: Database, destinationPath: string): Promise<void> {
  rmSync(destinationPath, { force: true });
  await backup(db, destinationPath);
}

export function nowIso(): string {
  return new Date().toISOString();
}
