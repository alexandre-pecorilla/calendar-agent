/**
 * Identity derivation. Nothing about the owner is hardcoded anywhere: the
 * owner's name, aliases and the Slack-facing bot name all come from the
 * environment (scope §20). A repository test fails the build if an owner name
 * literal ever appears in src/.
 */

export const BOT_NAME_SUFFIX = '-calendar-agent';
export const BOT_NAME_MAX = 32; // Slack slash-command limit
export const BOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Lowercase ASCII slug: accents stripped, runs of non-alphanumerics → '-'. */
export function slugifyName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `BOT_NAME` when given (validated), else `<slug>-calendar-agent` with the
 * name part trimmed so the whole fits Slack's 32-character command limit.
 */
export function deriveBotName(ownerName: string, explicit?: string): string {
  if (explicit !== undefined && explicit !== '') {
    if (!BOT_NAME_RE.test(explicit)) {
      throw new Error(
        `BOT_NAME must match ${BOT_NAME_RE} (lowercase letters, digits, hyphens, max ${BOT_NAME_MAX}).`,
      );
    }
    return explicit;
  }
  let slug = slugifyName(ownerName);
  if (!slug) throw new Error('OWNER_NAME must contain at least one letter or digit.');
  const room = BOT_NAME_MAX - BOT_NAME_SUFFIX.length;
  if (slug.length > room) slug = slug.slice(0, room).replace(/-+$/g, '');
  return `${slug}${BOT_NAME_SUFFIX}`;
}

/** Comma-separated aliases → trimmed, de-duplicated, non-empty list. */
export function parseAliases(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

const FR_VOWEL_START = /^[aeiouyhàâäéèêëîïôöùûü]/i;

/** French "de" + name with elision: "d'Anne", "de Marie", "d'Hélène". */
export function frenchDe(name: string): string {
  return FR_VOWEL_START.test(name) ? `d'${name}` : `de ${name}`;
}

/** English possessive: "Anne's", "James's". */
export function englishPossessive(name: string): string {
  return `${name}'s`;
}

/** Every name form the parser must treat as the owner. */
export function ownerNameForms(ownerName: string, aliases: readonly string[]): string[] {
  const forms = [ownerName, ...aliases];
  return [...new Set(forms.map((f) => f.trim()).filter(Boolean))];
}
