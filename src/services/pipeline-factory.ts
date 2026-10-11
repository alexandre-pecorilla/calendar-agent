import { CalcomCache } from '../calcom/cache.js';
import { CalcomClient } from '../calcom/client.js';
import type { AppConfig } from '../config/env.js';
import type { Repositories } from '../db/index.js';
import { DeepSeekClient } from '../llm/deepseek.js';
import type { Logger } from '../logging/logger.js';
import { AnswerPipeline } from '../pipeline/answer.js';
import { secretProvider } from './keys.js';

export interface Services {
  calcom: CalcomClient;
  calcomCache: CalcomCache;
  deepseek: DeepSeekClient;
  pipeline: AnswerPipeline;
}

/** Wire the providers and the pipeline from configuration and repositories. */
export function createServices(config: AppConfig, repos: Repositories, log: Logger): Services {
  const calcom = new CalcomClient({ apiKey: secretProvider(repos.settings, 'calcom_api_key', config.CALCOM_API_KEY), log });
  const calcomCache = new CalcomCache(calcom);
  const deepseek = new DeepSeekClient({ apiKey: secretProvider(repos.settings, 'deepseek_api_key', config.DEEPSEEK_API_KEY) });
  const pipeline = new AnswerPipeline({ config, settings: repos.settings, queries: repos.queries, calcom, calcomCache, deepseek, log });
  return { calcom, calcomCache, deepseek, pipeline };
}
