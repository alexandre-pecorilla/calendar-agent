import { DateTime } from 'luxon';
import { createServices } from '../services/pipeline-factory.js';
import { cliContext } from './context.js';

/**
 * `make ask q="…" [tz=…] [lang=…] [now=…]`: the command-line sandbox. Run inside
 * the container it uses the instance's keys and query log (entry point `cli`);
 * `make ask-host` runs it on the host with `./data` (developer use).
 */
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const q = opt('q');
if (!q) {
  console.error('usage: ask --q "question" [--tz Europe/Paris] [--lang fr] [--now 2026-10-09T12:00]  (--now is local time in --tz, or UTC when --tz is omitted)');
  process.exit(2);
}
const { config, repos, log } = cliContext();
const services = createServices(config, repos, log);
const tz = opt('tz') ?? null;
const lang = opt('lang');
const nowRaw = opt('now');
const now = nowRaw ? DateTime.fromISO(nowRaw, { zone: tz ?? 'UTC' }) : undefined;
const result = await services.pipeline.ask(
  { userId: 'cli', userName: 'cli', entryPoint: 'cli', askerTz: tz, askerLocale: lang ? (lang === 'fr' ? 'fr-FR' : 'en-US') : null, now },
  q,
);
console.log(result.text);
console.log('---');
console.log(JSON.stringify({ intent: result.intent, ...result.debug, parseRaw: undefined }, null, 2));
repos.db.close();
