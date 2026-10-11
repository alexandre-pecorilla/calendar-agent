import { neutralizeControlTokens } from './control-tokens.js';

export const QUESTION_MAX_CHARS = 500;

export interface SanitizedQuestion {
  text: string;
  truncated: boolean;
  empty: boolean;
}

/**
 * Normalise a Slack message into the question the parser sees: mention and
 * link markup removed, HTML entities decoded, whitespace collapsed, capped at
 * 500 characters, control tokens neutralised. Scope §6.5.
 */
export function sanitizeQuestion(raw: string | null | undefined): SanitizedQuestion {
  let text = (raw ?? '')
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, ' ')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]*)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = text.length > QUESTION_MAX_CHARS;
  if (truncated) text = text.slice(0, QUESTION_MAX_CHARS);
  text = neutralizeControlTokens(text);
  return { text, truncated, empty: text.length === 0 };
}
