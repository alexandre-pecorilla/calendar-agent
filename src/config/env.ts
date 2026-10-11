import { z } from 'zod';
import { deriveBotName, parseAliases } from './identity.js';

/**
 * Configuration: every variable validated once at boot, fail closed with a
 * message that names the variable and never its value.
 */

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

const schema = z.object({
  OWNER_NAME: z.string().trim().min(1).max(60),
  OWNER_ALIASES: z.string().optional(),
  BOT_NAME: z.string().trim().optional(),
  INSTALL_MODE: z.enum(['single', 'multi']).default('single'),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(8400),
  APP_HOST: z.string().trim().min(1).default('127.0.0.1'),
  APP_BIND_ADDRESSES: z.string().trim().default('127.0.0.1'),
  PUBLIC_BASE_URL: z.string().trim().url().optional(),
  SLACK_APP_TOKEN: z.string().regex(/^xapp-/, 'must start with xapp-'),
  /** Unused in Socket Mode (no HTTP receiver); accepted for a future one. */
  SLACK_SIGNING_SECRET: z.string().min(8).optional(),
  SLACK_BOT_TOKEN: z.string().regex(/^xoxb-/, 'must start with xoxb-').optional(),
  SLACK_CLIENT_ID: z.string().trim().min(1).optional(),
  SLACK_CLIENT_SECRET: z.string().min(1).optional(),
  SLACK_STATE_SECRET: z.string().min(16).optional(),
  ADMIN_PASSWORD: z.string().min(8),
  MASTER_KEY: z.string().min(1),
  CALCOM_API_KEY: z.string().trim().optional(),
  DEEPSEEK_API_KEY: z.string().trim().optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATA_DIR: z.string().trim().min(1).default('./data'),
  SLACK_ENABLED: z.enum(['true', 'false']).default('true'),
});

/** Variables whose template placeholder (`xapp-...`) must never be accepted as a value (R3-2). */
const SECRET_VARIABLES = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_CLIENT_SECRET', 'SLACK_STATE_SECRET', 'CALCOM_API_KEY', 'DEEPSEEK_API_KEY', 'ADMIN_PASSWORD', 'MASTER_KEY'] as const;

export type RawConfig = z.infer<typeof schema>;

export interface AppConfig extends RawConfig {
  ownerName: string;
  ownerAliases: string[];
  botName: string;
  slashCommand: string;
  bindAddresses: string[];
  installMode: 'single' | 'multi';
  slackEnabled: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const EMPTY_IS_UNSET = new Set(['SLACK_SIGNING_SECRET', 
  'BOT_NAME',
  'PUBLIC_BASE_URL',
  'SLACK_BOT_TOKEN',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_STATE_SECRET',
  'CALCOM_API_KEY',
  'DEEPSEEK_API_KEY',
  'SLACK_TEST_USER_TOKEN',
  'SLACK_TEST_CHANNEL_ID',
  'OWNER_ALIASES',
]);

/** A value that starts with `#` is an inline comment that a parser kept (Compose does for empty values, R2-2). */
function rejectPlaceholderValues(input: Record<string, string | undefined>): void {
  const bad = SECRET_VARIABLES.filter((k) => typeof input[k] === 'string' && /(\.\.\.|…)\s*$/.test(input[k]!));
  if (bad.length) throw new ConfigError(`Invalid configuration: ${bad.join(', ')} still hold the template placeholder (ending in ...): paste the real value, or leave the line empty.`);
}

function rejectCommentValues(input: Record<string, string | undefined>): void {
  const bad = Object.entries(input)
    .filter(([, v]) => typeof v === 'string' && v.trim().startsWith('#'))
    .map(([k]) => k);
  if (bad.length) throw new ConfigError(`Invalid configuration: ${bad.join(', ')} look like comments (put comments on their own line in .env).`);
}

/**
 * The subset needed before the Slack app exists: identity, mode and public URL,
 * for `make manifest` (R2-4). No secret is required.
 */
export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): Pick<AppConfig, 'ownerName' | 'ownerAliases' | 'botName' | 'slashCommand' | 'installMode' | 'PUBLIC_BASE_URL'> {
  const sub = schema.pick({ OWNER_NAME: true, OWNER_ALIASES: true, BOT_NAME: true, INSTALL_MODE: true, PUBLIC_BASE_URL: true });
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(sub.shape)) {
    const v = env[key];
    input[key] = v !== undefined && v.trim() === '' ? undefined : v;
  }
  rejectCommentValues(input);
  const parsed = sub.safeParse(input);
  if (!parsed.success) throw new ConfigError(`Invalid configuration: ${[...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '?')))].join(', ')}.`);
  const raw = parsed.data;
  let botName: string;
  try {
    botName = deriveBotName(raw.OWNER_NAME, raw.BOT_NAME);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  if (raw.INSTALL_MODE === 'multi' && (!raw.PUBLIC_BASE_URL || !raw.PUBLIC_BASE_URL.startsWith('https://'))) throw new ConfigError('INSTALL_MODE=multi requires an https:// PUBLIC_BASE_URL.');
  return { ownerName: raw.OWNER_NAME, ownerAliases: parseAliases(raw.OWNER_ALIASES), botName, slashCommand: `/${botName}`, installMode: raw.INSTALL_MODE, PUBLIC_BASE_URL: raw.PUBLIC_BASE_URL };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const v = env[key];
    input[key] = v !== undefined && v.trim() === '' && EMPTY_IS_UNSET.has(key) ? undefined : v;
  }
  rejectCommentValues(input);
  rejectPlaceholderValues(input);
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '?')))];
    throw new ConfigError(`Invalid configuration: ${names.join(', ')}. Check .env (values are never printed).`);
  }
  const raw = parsed.data;
  if (raw.INSTALL_MODE === 'multi') {
    const missing = (['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_STATE_SECRET', 'PUBLIC_BASE_URL'] as const).filter(
      (k) => !raw[k],
    );
    if (missing.length) throw new ConfigError(`INSTALL_MODE=multi requires: ${missing.join(', ')}.`);
    if (!raw.PUBLIC_BASE_URL!.startsWith('https://')) throw new ConfigError('PUBLIC_BASE_URL must be https:// (Slack requires an HTTPS redirect URL).');
  } else if (!raw.SLACK_BOT_TOKEN) {
    throw new ConfigError('INSTALL_MODE=single requires SLACK_BOT_TOKEN.');
  }
  const bindAddresses = raw.APP_BIND_ADDRESSES.split(',').map((s) => s.trim()).filter(Boolean);
  if (bindAddresses.length === 0 || bindAddresses.length > 2) throw new ConfigError('APP_BIND_ADDRESSES must list one or two addresses.');
  if (bindAddresses.includes('0.0.0.0') || bindAddresses.includes('::')) throw new ConfigError('APP_BIND_ADDRESSES must not contain a wildcard address.');
  let botName: string;
  try {
    botName = deriveBotName(raw.OWNER_NAME, raw.BOT_NAME);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  return {
    ...raw,
    ownerName: raw.OWNER_NAME,
    ownerAliases: parseAliases(raw.OWNER_ALIASES),
    botName,
    slashCommand: `/${botName}`,
    bindAddresses,
    installMode: raw.INSTALL_MODE,
    slackEnabled: raw.SLACK_ENABLED === 'true',
  };
}
