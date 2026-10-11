import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logging/logger.js';

function capture(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, lines: () => chunks.join('').split('\n').filter(Boolean) };
}

describe('logger redaction', () => {
  it('censors content and secret fields at any depth', () => {
    const { stream, lines } = capture();
    const log = createLogger('info', stream);
    log.info(
      {
        text: 'is Alex free tomorrow',
        answer: 'yes',
        password: 'pw-123456',
        nested: { token: 'xoxb-secret', apiKey: 'cal_live_ab', deeper: { secret: 's3' } },
        req: { headers: { authorization: 'Bearer zzz', cookie: 'a=b' } },
        keep: 'visible',
      },
      'event',
    );
    const out = lines().join('\n');
    expect(out).toContain('"keep":"visible"');
    for (const leaked of ['is Alex free', 'pw-123456', 'xoxb-secret', 'cal_live_ab', '"s3"', 'Bearer zzz', 'a=b']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('[redacted]');
  });
});
