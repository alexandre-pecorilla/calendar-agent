import { readFileSync } from 'node:fs';
import type { Lang } from '../availability/timezone.js';
import type { DeepSeekClient, Usage } from './deepseek.js';
import { verifyReply, type Draft } from './verify.js';

/**
 * Rewriting a draft needs no reasoning: thinking is off for this call (D19).
 * Measured 2026-10-09: with thinking on at low effort the rewrite spent
 * 450–750 reasoning tokens and 3–5 s; off it is a sub-second call.
 */
export const PHRASE_THINKING = 'off' as const;

export const PHRASE_PROMPT_PATH = new URL('./prompts/phrase.md', import.meta.url);
let template: string | null = null;
export function phrasePromptTemplate(): string {
  if (!template) template = readFileSync(PHRASE_PROMPT_PATH, 'utf8');
  return template;
}

export interface PhraseOutcome {
  text: string;
  phrased: boolean;
  verification: string;
  usage: Usage | null;
  latencyMs: number;
}

/**
 * Call 2: receives only code-generated text (the deterministic draft), never
 * the asker's question. Its output is accepted only if verification passes;
 * otherwise the draft itself is the reply.
 */
export async function phraseReply(
  client: DeepSeekClient,
  args: { ownerName: string; lang: Lang; draft: Draft },
): Promise<PhraseOutcome> {
  const system = phrasePromptTemplate()
    .replaceAll('{{OWNER_NAME}}', args.ownerName)
    .replaceAll('{{LANGUAGE_NAME}}', args.lang === 'fr' ? 'French' : 'English')
    .replaceAll('{{DRAFT}}', args.draft.text);
  try {
    const res = await client.complete({ system, user: 'Rewrite the draft now.', json: false, maxTokens: 600, effort: PHRASE_THINKING });
    const v = verifyReply(res.content, args.draft, args.lang);
    if (v.ok) return { text: res.content.trim(), phrased: true, verification: 'ok', usage: res.usage, latencyMs: res.latencyMs };
    return { text: args.draft.text, phrased: false, verification: v.reason ?? 'failed', usage: res.usage, latencyMs: res.latencyMs };
  } catch (err) {
    return { text: args.draft.text, phrased: false, verification: `error:${(err as Error).name}`, usage: null, latencyMs: 0 };
  }
}
