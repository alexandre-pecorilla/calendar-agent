import { ConfigError, loadConfig, type AppConfig } from '../config/env.js';
import { parseMasterKey } from '../crypto/envelope.js';
import { createRepositories, type Repositories } from '../db/index.js';
import { seedSecretsFromEnv } from '../db/repos/settings.js';
import { createLogger, type Logger } from '../logging/logger.js';

/**
 * Shared bootstrap for the CLIs (`ask`, `calcom-check`, `deepseek-check`):
 * one-line configuration errors, the database of `DATA_DIR` (the instance's
 * volume when run inside the container, `./data` on the host), env seeding.
 * The provider keys come from that database first, like the app (R3-3, R3-6).
 */
export function cliContext(): { config: AppConfig; repos: Repositories; log: Logger } {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  let master: ReturnType<typeof parseMasterKey>;
  try {
    master = parseMasterKey(config.MASTER_KEY);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const repos = createRepositories(config.DATA_DIR, master);
  seedSecretsFromEnv(repos.settings, config);
  return { config, repos, log: createLogger('warn') };
}
