import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope encryption for everything stored that would be
 * damaging to leak: provider API keys, Slack bot tokens. Ported from an earlier internal project
 * (`apps/server/src/crypto/envelope.ts`).
 *
 * Why: the SQLite file is the backup the owner will copy around. Anything
 * readable in it is effectively published. Column-level encryption means a
 * stolen file is inert without the master key, which lives only in `.env`.
 *
 * Format, self-describing so rotation or algorithm changes are detectable:
 *     v1.<key-id>.<iv-b64>.<ciphertext-b64>.<authtag-b64>
 * GCM is authenticated: tampering with any part fails the tag check and
 * throws; it never returns wrong plaintext silently.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export interface MasterKey {
  /** Short, non-secret identifier recorded in every ciphertext. */
  id: string;
  key: Buffer;
}

/**
 * Parse and validate the master key from its base64 form. Fails closed at
 * startup; the error never contains key material.
 */
export function parseMasterKey(encoded: string, id = 'k1'): MasterKey {
  let key: Buffer;
  try {
    key = Buffer.from(encoded.trim(), 'base64');
  } catch {
    throw new Error('MASTER_KEY is not valid base64.');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `MASTER_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  if (key.every((byte) => byte === key[0])) {
    throw new Error('MASTER_KEY looks like a placeholder. Generate a real one: openssl rand -base64 32');
  }
  return { id, key };
}

export function encrypt(master: MasterKey, plaintext: string, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, master.key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, master.id, iv.toString('base64'), ct.toString('base64'), tag.toString('base64')].join('.');
}

/** The key id recorded in a ciphertext (`v1.<id>.…`), or null if the format is unknown. */
export function ciphertextKeyId(token: string): string | null {
  const parts = token.split('.');
  return parts.length === 5 && parts[0] === 'v1' && parts[1] ? parts[1] : null;
}

export function decrypt(master: MasterKey, token: string, aad?: string): string {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) throw new DecryptionError('Unrecognised ciphertext format.');
  const [, keyId, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  if (keyId !== master.id) throw new DecryptionError(`Ciphertext was made with key "${keyId}", current key is "${master.id}".`);
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError('Malformed ciphertext.');
  try {
    const decipher = createDecipheriv(ALGORITHM, master.key, iv, { authTagLength: TAG_BYTES });
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptionError('Decryption failed: wrong key or tampered data.');
  }
}

export function isCiphertext(value: string): boolean {
  return value.startsWith(`${VERSION}.`) && value.split('.').length === 5;
}
