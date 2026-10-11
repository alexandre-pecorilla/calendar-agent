import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadIdentityConfig } from '../../src/config/env.js';

const SECRET_MARKER = 'super-secret-value-9f8e7d';

function base(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    OWNER_NAME: 'Alex',
    OWNER_ALIASES: 'Alexandre, Alexandre Dupont',
    INSTALL_MODE: 'single',
    SLACK_APP_TOKEN: 'xapp-1-A-1-x',
    SLACK_SIGNING_SECRET: 'signing-secret-x',
    SLACK_BOT_TOKEN: 'xoxb-1-1-x',
    ADMIN_PASSWORD: 'correct-horse-battery',
    MASTER_KEY: 'bWFzdGVyLWtleS1wbGFjZWhvbGRlci0zMi1ieXRlcw==',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('loads a valid single-mode configuration with derived values', () => {
    const c = loadConfig(base());
    expect(c.botName).toBe('alex-calendar-agent');
    expect(c.slashCommand).toBe('/alex-calendar-agent');
    expect(c.ownerAliases).toEqual(['Alexandre', 'Alexandre Dupont']);
    expect(c.bindAddresses).toEqual(['127.0.0.1']);
    expect(c.APP_PORT).toBe(8400);
    expect(c.installMode).toBe('single');
    expect(c.slackEnabled).toBe(true);
  });

  it('names the missing variable and never prints a value', () => {
    const env = base({ SLACK_APP_TOKEN: SECRET_MARKER });
    expect(() => loadConfig(env)).toThrow(ConfigError);
    try {
      loadConfig(env);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('SLACK_APP_TOKEN');
      expect(msg).not.toContain(SECRET_MARKER);
    }
  });

  it('requires SLACK_BOT_TOKEN in single mode', () => {
    expect(() => loadConfig(base({ SLACK_BOT_TOKEN: '' }))).toThrow(/SLACK_BOT_TOKEN/);
  });

  it('requires client credentials and an https public URL in multi mode', () => {
    expect(() => loadConfig(base({ INSTALL_MODE: 'multi', SLACK_BOT_TOKEN: undefined }))).toThrow(
      /SLACK_CLIENT_ID.*SLACK_CLIENT_SECRET.*SLACK_STATE_SECRET.*PUBLIC_BASE_URL/,
    );
    const multi = base({
      INSTALL_MODE: 'multi',
      SLACK_CLIENT_ID: '1.2',
      SLACK_CLIENT_SECRET: 'cs',
      SLACK_STATE_SECRET: 'state-secret-long-enough',
      PUBLIC_BASE_URL: 'http://plain.example',
    });
    expect(() => loadConfig(multi)).toThrow(/https/);
    expect(loadConfig({ ...multi, PUBLIC_BASE_URL: 'https://host.example:8445' }).installMode).toBe('multi');
  });

  it('refuses wildcard and too many bind addresses', () => {
    expect(() => loadConfig(base({ APP_BIND_ADDRESSES: '0.0.0.0' }))).toThrow(/wildcard/);
    expect(() => loadConfig(base({ APP_BIND_ADDRESSES: '127.0.0.1,10.0.0.1,10.0.0.2' }))).toThrow(/one or two/);
    expect(loadConfig(base({ APP_BIND_ADDRESSES: '127.0.0.1, 100.64.0.1' })).bindAddresses).toEqual([
      '127.0.0.1',
      '100.64.0.1',
    ]);
  });

  it('treats empty optional variables as unset and validates BOT_NAME', () => {
    expect(loadConfig(base({ BOT_NAME: '', CALCOM_API_KEY: '' })).botName).toBe('alex-calendar-agent');
    expect(() => loadConfig(base({ BOT_NAME: 'Not Valid' }))).toThrow(/BOT_NAME/);
    expect(loadConfig(base({ BOT_NAME: 'alex-p-calendar-agent' })).slashCommand).toBe('/alex-p-calendar-agent');
  });

  it('refuses a short admin password and an unknown log level', () => {
    expect(() => loadConfig(base({ ADMIN_PASSWORD: 'short' }))).toThrow(/ADMIN_PASSWORD/);
    expect(() => loadConfig(base({ LOG_LEVEL: 'loud' }))).toThrow(/LOG_LEVEL/);
  });

  it('refuses the template placeholders and accepts a missing signing secret (R3-2, R3-16)', () => {
    expect(() => loadConfig(base({ SLACK_APP_TOKEN: 'xapp-...' }))).toThrow(/SLACK_APP_TOKEN still hold the template placeholder/);
    expect(() => loadConfig(base({ CALCOM_API_KEY: 'cal_live_...' }))).toThrow(/CALCOM_API_KEY/);
    expect(() => loadConfig(base({ DEEPSEEK_API_KEY: 'sk-…' }))).toThrow(/DEEPSEEK_API_KEY/);
    try {
      loadConfig(base({ SLACK_BOT_TOKEN: 'xoxb-...' }));
    } catch (err) {
      expect((err as Error).message).not.toContain('xoxb-...');
    }
    expect(loadConfig(base({ SLACK_SIGNING_SECRET: undefined })).SLACK_SIGNING_SECRET).toBeUndefined();
    expect(loadConfig(base({ SLACK_SIGNING_SECRET: '' })).SLACK_SIGNING_SECRET).toBeUndefined();
  });

  it('refuses a value that is really an inline comment (R2-2)', () => {
    expect(() => loadConfig(base({ APP_PORT: '# container port' }))).toThrow(/APP_PORT look like comments/);
    expect(() => loadConfig(base({ OWNER_ALIASES: '  # none yet' }))).toThrow(/own line/);
  });
});

describe('loadIdentityConfig', () => {
  it('needs only the identity variables, for the manifest before any secret exists (R2-4)', () => {
    const id = loadIdentityConfig({ OWNER_NAME: 'Émilie Dupont' });
    expect(id).toMatchObject({ ownerName: 'Émilie Dupont', botName: 'emilie-dupont-calendar-agent', slashCommand: '/emilie-dupont-calendar-agent', installMode: 'single' });
    expect(loadIdentityConfig({ OWNER_NAME: 'Alex', BOT_NAME: 'alex-bot', INSTALL_MODE: 'multi', PUBLIC_BASE_URL: 'https://h.example:8445' }).PUBLIC_BASE_URL).toBe('https://h.example:8445');
  });

  it('still validates what it reads, with one-line errors and no values', () => {
    expect(() => loadIdentityConfig({})).toThrow(ConfigError);
    expect(() => loadIdentityConfig({})).toThrow(/OWNER_NAME/);
    expect(() => loadIdentityConfig({ OWNER_NAME: 'Alex', INSTALL_MODE: 'multi' })).toThrow(/https:\/\/ PUBLIC_BASE_URL/);
    expect(() => loadIdentityConfig({ OWNER_NAME: 'Alex', BOT_NAME: 'Not Valid' })).toThrow(/BOT_NAME/);
    expect(() => loadIdentityConfig({ OWNER_NAME: '# comment' })).toThrow(/comments/);
  });
});
