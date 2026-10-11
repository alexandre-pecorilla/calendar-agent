import { describe, expect, it } from 'vitest';
import { DecryptionError, decrypt, encrypt, isCiphertext, parseMasterKey } from '../../src/crypto/envelope.js';
import { Secret } from '../../src/crypto/secret.js';
import { inspect } from 'node:util';

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString('base64');
const OTHER_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 7) % 256)).toString('base64');

describe('envelope', () => {
  const master = parseMasterKey(KEY_B64);

  it('round-trips with and without associated data', () => {
    const ct = encrypt(master, 'cal_live_example', 'calcom_api_key');
    expect(isCiphertext(ct)).toBe(true);
    expect(ct).not.toContain('cal_live_example');
    expect(decrypt(master, ct, 'calcom_api_key')).toBe('cal_live_example');
    const ct2 = encrypt(master, 'plain');
    expect(decrypt(master, ct2)).toBe('plain');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encrypt(master, 'x')).not.toBe(encrypt(master, 'x'));
  });

  it('fails on tampered parts, wrong AAD, wrong key', () => {
    const ct = encrypt(master, 'value', 'k');
    const parts = ct.split('.');
    for (const i of [2, 3, 4]) {
      const bad = [...parts];
      bad[i] = Buffer.from(Buffer.from(bad[i]!, 'base64').map((b, j) => (j === 0 ? b ^ 0xff : b))).toString('base64');
      expect(() => decrypt(master, bad.join('.'), 'k')).toThrow(DecryptionError);
    }
    expect(() => decrypt(master, ct, 'other')).toThrow(DecryptionError);
    expect(() => decrypt(parseMasterKey(OTHER_B64), ct, 'k')).toThrow(DecryptionError);
    expect(() => decrypt(master, 'v2.k1.a.b.c', 'k')).toThrow(DecryptionError);
    expect(() => decrypt(parseMasterKey(KEY_B64, 'k2'), ct, 'k')).toThrow(/key "k1"/);
  });

  it('refuses placeholder, short and invalid master keys', () => {
    expect(() => parseMasterKey(Buffer.alloc(32, 7).toString('base64'))).toThrow(/placeholder/);
    expect(() => parseMasterKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseMasterKey('')).toThrow(/32 bytes/);
  });
});

describe('Secret', () => {
  it('never prints its value', () => {
    const s = new Secret('tok-very-secret-value');
    expect(String(s)).toBe('[secret]');
    expect(JSON.stringify({ s })).toBe('{"s":"[secret]"}');
    expect(inspect(s)).toBe('[secret]');
    expect(`${s}`).toBe('[secret]');
    expect(s.masked()).toBe('••••alue');
    expect(new Secret('short').masked()).toBe('••••');
    expect(s.reveal()).toBe('tok-very-secret-value');
  });
});
