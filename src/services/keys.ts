import type { Secret } from '../crypto/secret.js';
import { Secret as SecretClass } from '../crypto/secret.js';
import type { SettingsRepository, SecretSettingKey } from '../db/repos/settings.js';

/** Database value first (rotatable in the admin), env as the fallback. */
export function secretProvider(settings: SettingsRepository | null, key: SecretSettingKey, envValue: string | undefined): () => Secret | null {
  return () => {
    const fromDb = settings?.getSecret(key) ?? null;
    if (fromDb) return fromDb;
    const v = envValue?.trim();
    return v ? new SecretClass(v) : null;
  };
}
