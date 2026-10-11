/**
 * Break provider control-token sequences inside untrusted text. Ported from
 * an earlier internal project (`apps/server/src/security/control-tokens.ts`).
 *
 * The threat: a question carries a sequence the tokenizer turns into a REAL
 * special token (DeepSeek `<｜…｜>` / `<|DSML|`, ChatML `<|im_start|>`,
 * `<tool_call>` / `<function=>` markup). A zero-width space after the `<`
 * breaks the sequence at the tokenizer while leaving it visually identical,
 * so untrusted content can never forge role or tool framing.
 */
export function neutralizeControlTokens(text: string): string {
  const zwsp = '​';
  return text.replace(/<(?=[|｜]|tool_call|function[_=])/gi, '<' + zwsp);
}
