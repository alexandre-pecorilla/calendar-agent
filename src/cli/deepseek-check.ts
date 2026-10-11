import { DeepSeekClient } from '../llm/deepseek.js';
import { secretProvider } from '../services/keys.js';
import { cliContext } from './context.js';

/** `make deepseek-check`: one tiny completion, prints usage and cost. Uses the key the instance uses (admin Settings, else .env). */
const { config, repos } = cliContext();
const apiKey = secretProvider(repos.settings, 'deepseek_api_key', config.DEEPSEEK_API_KEY);
if (!apiKey()) {
  console.error('No DeepSeek API key: paste it in the admin Settings, or set DEEPSEEK_API_KEY in .env before the first start.');
  repos.db.close();
  process.exit(2);
}
const client = new DeepSeekClient({ apiKey });
try {
  const res = await client.complete({ system: 'Reply with the single word OK.', user: 'Ready?', json: false, maxTokens: 200, effort: 'low' });
  console.log(`deepseek-check: content="${res.content.slice(0, 40)}" tokens=${res.usage.promptTokens}+${res.usage.completionTokens} cacheHit=${res.usage.cacheHitTokens} cost=$${res.usage.costUsd.toFixed(6)} latency=${res.latencyMs}ms retried=${res.retried}`);
  console.log('deepseek-check: OK');
} catch (err) {
  console.error('deepseek-check: FAILED:', (err as Error).message);
  process.exit(1);
}
