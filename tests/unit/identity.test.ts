import { describe, expect, it } from 'vitest';
import {
  deriveBotName,
  englishPossessive,
  frenchDe,
  ownerNameForms,
  parseAliases,
  slugifyName,
} from '../../src/config/identity.js';

describe('identity', () => {
  it('slugifies names', () => {
    expect(slugifyName('Alex')).toBe('alex');
    expect(slugifyName('Jérôme')).toBe('jerome');
    expect(slugifyName('Marie-Claire')).toBe('marie-claire');
    expect(slugifyName('  Jean Paul  ')).toBe('jean-paul');
    expect(slugifyName('Ünïcödé Nämé!')).toBe('unicode-name');
  });

  it('derives the bot name from the owner name', () => {
    expect(deriveBotName('Alex')).toBe('alex-calendar-agent');
    expect(deriveBotName('Jérôme')).toBe('jerome-calendar-agent');
    expect(deriveBotName('Marie-Claire')).toBe('marie-claire-calendar-agent');
  });

  it('caps the derived name at 32 characters and keeps the suffix', () => {
    const name = deriveBotName('Maximilian-Alexander-Bartholomew-Longname');
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name.endsWith('-calendar-agent')).toBe(true);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  });

  it('accepts a valid explicit bot name and refuses invalid ones', () => {
    expect(deriveBotName('Alex', 'alex-p-calendar-agent')).toBe('alex-p-calendar-agent');
    expect(() => deriveBotName('Alex', 'Alex Bot')).toThrow(/BOT_NAME/);
    expect(() => deriveBotName('Alex', 'a'.repeat(33))).toThrow(/BOT_NAME/);
    expect(() => deriveBotName('Alex', '-bad')).toThrow(/BOT_NAME/);
  });

  it('refuses an owner name without letters or digits', () => {
    expect(() => deriveBotName('!!!')).toThrow(/OWNER_NAME/);
  });

  it('parses aliases', () => {
    expect(parseAliases(undefined)).toEqual([]);
    expect(parseAliases('')).toEqual([]);
    expect(parseAliases('Alexandre, Alexandre Dupont ,, alexandre')).toEqual([
      'Alexandre',
      'Alexandre Dupont',
    ]);
  });

  it('elides French de', () => {
    expect(frenchDe('Alex')).toBe("d'Alex");
    expect(frenchDe('Marie')).toBe('de Marie');
    expect(frenchDe('Hélène')).toBe("d'Hélène");
    expect(frenchDe('Yves')).toBe("d'Yves");
  });

  it('forms the English possessive', () => {
    expect(englishPossessive('Alex')).toBe("Alex's");
    expect(englishPossessive('James')).toBe("James's");
  });

  it('lists every owner name form once', () => {
    expect(ownerNameForms('Alex', ['Alexandre', 'Alex'])).toEqual(['Alex', 'Alexandre']);
  });
});
