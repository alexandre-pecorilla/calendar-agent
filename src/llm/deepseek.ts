import OpenAI from 'openai';
import type { Secret } from '../crypto/secret.js';

/**
 * DeepSeek V4.1 Flash through its OpenAI-compatible endpoint (official docs,
 * fetched 2026-10-09; shapes cross-checked with an earlier internal project's provider table):
 * model `deepseek-flash`, thinking on as a request parameter plus
 * `reasoning_effort` low|high|max, JSON mode via `response_format`, and the
 * word "json" plus an example in the prompt. No tools are ever declared
 * (scope §6.1): the only outputs are a JSON object or a short text.
 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = 'deepseek-flash';
export const EFFORT_LEVELS = ['low', 'high', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
/** `off` disables thinking entirely (verified live: `thinking: {type: 'disabled'}`). */
export type ThinkingSetting = Effort | 'off';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  /** Thinking tokens, a subset of completionTokens (DeepSeek bills them as output). */
  reasoningTokens: number;
  costUsd: number;
}

export interface Completion {
  content: string;
  usage: Usage;
  latencyMs: number;
  retried: boolean;
}

export type DeepSeekErrorKind = 'not_configured' | 'unauthorized' | 'unavailable' | 'empty' | 'bad_response';

export class DeepSeekError extends Error {
  constructor(
    readonly kind: DeepSeekErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

/** Pricing page, 2026-10-09, USD per million tokens. */
const PRICE = {
  offPeak: { miss: 0.15, hit: 0.003, out: 0.6 },
  peak: { miss: 0.3, hit: 0.006, out: 1.2 },
};

/** Peak = 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday (Chinese public holidays ignored: conservative). */
export function isPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function estimateCost(u: { promptTokens: number; completionTokens: number; cacheHitTokens: number }, at: Date): number {
  const p = isPeak(at) ? PRICE.peak : PRICE.offPeak;
  const miss = Math.max(u.promptTokens - u.cacheHitTokens, 0);
  return (miss * p.miss + u.cacheHitTokens * p.hit + u.completionTokens * p.out) / 1_000_000;
}

export interface DeepSeekOptions {
  apiKey: () => Secret | null;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export interface CompleteArgs {
  system: string;
  user: string;
  json: boolean;
  maxTokens: number;
  effort?: ThinkingSetting;
}

export class DeepSeekClient {
  private readonly model: string;
  private readonly now: () => Date;

  constructor(private readonly opts: DeepSeekOptions) {
    this.model = opts.model ?? DEEPSEEK_MODEL;
    this.now = opts.now ?? (() => new Date());
  }

  private client(): OpenAI {
    const key = this.opts.apiKey();
    if (!key) throw new DeepSeekError('not_configured', 'No DeepSeek API key is configured.');
    return new OpenAI({
      apiKey: key.reveal(),
      baseURL: this.opts.baseUrl ?? DEEPSEEK_BASE_URL,
      timeout: this.opts.timeoutMs ?? 30_000,
      maxRetries: 0,
      ...(this.opts.fetchImpl ? { fetch: this.opts.fetchImpl as never } : {}),
    });
  }

  async complete(args: CompleteArgs): Promise<Completion> {
    const thinkingOff = args.effort === 'off';
    const effort: Effort = !thinkingOff && args.effort && (EFFORT_LEVELS as readonly string[]).includes(args.effort) ? (args.effort as Effort) : 'low';
    const client = this.client();
    const started = Date.now();
    let retried = false;
    // Reasoning tokens count inside max_tokens (verified live 2026-10-09: a 20-token
    // cap returned finish_reason "length" with empty content), so the cap must leave
    // room for the thinking; an empty answer is retried once with a doubled cap.
    for (let attempt = 1; ; attempt++) {
      let res: OpenAI.Chat.Completions.ChatCompletion;
      try {
        res = await client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: args.system },
            { role: 'user', content: args.user },
          ],
          temperature: 0,
          max_tokens: attempt === 1 ? args.maxTokens : args.maxTokens * 2,
          ...(args.json ? { response_format: { type: 'json_object' as const } } : {}),
          // DeepSeek-specific request parameters (not in the OpenAI types).
          ...((thinkingOff ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: effort }) as Record<string, unknown>),
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) throw new DeepSeekError('unauthorized', 'DeepSeek rejected the API key.');
        if (attempt === 1) {
          retried = true;
          continue;
        }
        throw new DeepSeekError('unavailable', `DeepSeek unreachable: ${(err as Error).name}`);
      }
      const content = (res.choices[0]?.message?.content ?? '').trim();
      const u = res.usage as (OpenAI.Completions.CompletionUsage & { prompt_cache_hit_tokens?: number }) | undefined;
      const usageRaw = {
        promptTokens: u?.prompt_tokens ?? 0,
        completionTokens: u?.completion_tokens ?? 0,
        cacheHitTokens: u?.prompt_cache_hit_tokens ?? 0,
        reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
      };
      if (!content) {
        if (attempt === 1) {
          retried = true;
          continue;
        }
        throw new DeepSeekError('empty', 'DeepSeek returned empty content twice.');
      }
      return {
        content,
        usage: { ...usageRaw, costUsd: estimateCost(usageRaw, this.now()) },
        latencyMs: Date.now() - started,
        retried,
      };
    }
  }
}
