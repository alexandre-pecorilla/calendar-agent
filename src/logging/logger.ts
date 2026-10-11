import pino from 'pino';

/**
 * Structured logging with redaction. Scope §12/§13: logs never carry question
 * or answer text, nor any secret. Content lives in the database only. Anything
 * that reaches the logger under one of these keys is censored regardless of
 * depth.
 */
const SENSITIVE_KEYS = [
  'text',
  'answer',
  'question',
  'reply',
  'token',
  'apiKey',
  'api_key',
  'password',
  'secret',
  'authorization',
  'cookie',
  'bot_token',
  'botToken',
  'access_token',
];

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const k of SENSITIVE_KEYS) {
    paths.push(k, `*.${k}`, `*.*.${k}`, `req.headers.${k}`, `res.headers.${k}`);
  }
  paths.push('req.headers.authorization', 'req.headers.cookie');
  return paths;
}

export type Logger = pino.Logger;

export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    redact: { paths: redactPaths(), censor: '[redacted]' },
    base: { app: 'calendar-agent' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}
