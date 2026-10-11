import { writeFileSync } from 'node:fs';
import { ConfigError, loadIdentityConfig } from '../config/env.js';
import { renderManifest } from '../slack/manifest.js';

/** `make manifest`: writes manifest.json from the identity part of .env (no secret needed yet) and prints it. */
let config;
try {
  config = loadIdentityConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}
const manifest = renderManifest(config);
const json = JSON.stringify(manifest, null, 2) + '\n';
writeFileSync('manifest.json', json);
console.log(json);
console.error(`manifest.json written for ${config.botName} (${config.installMode} mode). Create the app at https://api.slack.com/apps → From a manifest → JSON.`);
