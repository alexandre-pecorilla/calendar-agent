import { ciphertextKeyId, decrypt, DecryptionError, encrypt, type MasterKey } from '../../crypto/envelope.js';
import { Secret } from '../../crypto/secret.js';
import { nowIso, type Database } from '../sqlite.js';

/** Setting keys. Secrets are encrypted with the key name as associated data. */
export const SECRET_SETTINGS = ['calcom_api_key', 'deepseek_api_key'] as const;
export type SecretSettingKey = (typeof SECRET_SETTINGS)[number];

export const NUMERIC_DEFAULTS = {
  horizon_days: 28,
  noise_floor_minutes: 15,
  listing_cap_days: 10,
  rate_user_per_minute: 10,
  rate_workspace_per_minute: 60,
  rate_global_per_minute: 100,
  daily_budget: 2000,
} as const;
export type NumericSettingKey = keyof typeof NUMERIC_DEFAULTS;

export interface SettingRow {
  key: string;
  value: string;
  encrypted: number;
  updated_at: string;
}

export class SettingsRepository {
  constructor(
    private readonly db: Database,
    private readonly master: MasterKey,
  ) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value, encrypted FROM settings WHERE key = ?').get(key) as
      | { value: string; encrypted: number }
      | undefined;
    if (!row) return null;
    if (row.encrypted) throw new Error(`Setting ${key} is encrypted; use getSecret().`);
    return row.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = 0, updated_at = excluded.updated_at`,
      )
      .run(key, value, nowIso());
  }

  getNumber(key: NumericSettingKey): number {
    const raw = this.get(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : NUMERIC_DEFAULTS[key];
  }

  getSecret(key: SecretSettingKey): Secret | null {
    const row = this.db.prepare('SELECT value, encrypted FROM settings WHERE key = ?').get(key) as
      | { value: string; encrypted: number }
      | undefined;
    if (!row) return null;
    if (!row.encrypted) throw new Error(`Setting ${key} is stored in clear; refusing to read it as a secret.`);
    try {
      return new Secret(decrypt(this.master, row.value, key));
    } catch (err) {
      // Encrypted with a previous MASTER_KEY: treated as absent so the admin stays usable (R3-1).
      if (err instanceof DecryptionError) return null;
      throw err;
    }
  }

  /** True when an encrypted row exists that the current master key cannot read (R3-1). */
  isUnreadable(key: string): boolean {
    const row = this.db.prepare('SELECT value, encrypted FROM settings WHERE key = ?').get(key) as
      | { value: string; encrypted: number }
      | undefined;
    if (!row || !row.encrypted) return false;
    try {
      decrypt(this.master, row.value, key);
      return false;
    } catch (err) {
      if (err instanceof DecryptionError) return true;
      throw err;
    }
  }

  /** Encrypted rows the current master key cannot read, with the key id they were made with. */
  unreadable(): Array<{ key: string; keyId: string | null }> {
    const rows = this.db.prepare('SELECT key, value FROM settings WHERE encrypted = 1 ORDER BY key').all() as unknown as Array<{ key: string; value: string }>;
    return rows.filter((r) => this.isUnreadable(r.key)).map((r) => ({ key: r.key, keyId: ciphertextKeyId(r.value) }));
  }

  setSecret(key: SecretSettingKey, value: string): void {
    const ct = encrypt(this.master, value, key);
    this.db
      .prepare(
        `INSERT INTO settings (key, value, encrypted, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = 1, updated_at = excluded.updated_at`,
      )
      .run(key, ct, nowIso());
  }

  has(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key) !== undefined;
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  /** Metadata only; never the value of an encrypted setting. */
  list(): Array<{ key: string; encrypted: boolean; updated_at: string; masked: string | null; unreadable: boolean }> {
    const rows = this.db.prepare('SELECT key, value, encrypted, updated_at FROM settings ORDER BY key').all() as unknown as SettingRow[];
    return rows.map((r) => ({
      key: r.key,
      encrypted: r.encrypted === 1,
      updated_at: r.updated_at,
      masked: r.encrypted ? this.getSecret(r.key as SecretSettingKey)?.masked() ?? null : null,
      unreadable: r.encrypted === 1 && this.isUnreadable(r.key),
    }));
  }
}

/** The template's `xxx-...` placeholders (and an elided value) are never a key (R3-2). */
export function isPlaceholderSecret(value: string): boolean {
  const v = value.trim();
  return v === '' || /(\.\.\.|…)$/.test(v);
}

/**
 * First-boot seeding: a key present in the environment and absent from the
 * database is imported encrypted, once. An existing database value always
 * wins, so rotating a key in the admin is never undone by a stale env file.
 * A row the current master key cannot read counts as absent (re-seeded after
 * a MASTER_KEY change, R3-1); a template placeholder is never seeded (R3-2).
 */
export function seedSecretsFromEnv(
  settings: SettingsRepository,
  env: { CALCOM_API_KEY?: string | undefined; DEEPSEEK_API_KEY?: string | undefined },
): SecretSettingKey[] {
  const seeded: SecretSettingKey[] = [];
  const pairs: Array<[SecretSettingKey, string | undefined]> = [
    ['calcom_api_key', env.CALCOM_API_KEY],
    ['deepseek_api_key', env.DEEPSEEK_API_KEY],
  ];
  for (const [key, value] of pairs) {
    if (value && !isPlaceholderSecret(value) && (!settings.has(key) || settings.isUnreadable(key))) {
      settings.setSecret(key, value.trim());
      seeded.push(key);
    }
  }
  return seeded;
}
