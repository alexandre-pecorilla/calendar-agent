import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The compose file keeps the container hardening and never publishes on a wildcard address. */
describe('deployment hardening', () => {
  const compose = readFileSync('docker-compose.yml', 'utf8');
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const gitignore = readFileSync('.gitignore', 'utf8');
  const dockerignore = readFileSync('.dockerignore', 'utf8');

  it('compose: read-only rootfs, caps dropped, no-new-privileges, limits, log rotation, healthcheck, non-root', () => {
    for (const needle of ['read_only: true', 'cap_drop:', '- ALL', 'no-new-privileges:true', 'mem_limit:', 'pids_limit:', 'max-size:', 'healthcheck:', 'user: node', 'restart: unless-stopped']) {
      expect(compose, needle).toContain(needle);
    }
    expect(compose).not.toMatch(/0\.0\.0\.0:\$\{APP_PORT/);
    expect(compose).toMatch(/\$\{APP_PUBLISH_1:\?/);
    expect(compose).not.toContain('network_mode: host');
    expect(compose).not.toContain('privileged');
  });

  it('compose passes an explicit allowlist of variables, never the whole .env (R2-13)', () => {
    expect(compose).not.toMatch(/^\s*env_file:/m);
    const example = readFileSync('.env.example', 'utf8');
    const keys = [...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) {
      if (['COMPOSE_PROJECT_NAME', 'APP_HOST', 'DATA_DIR'].includes(key)) continue;
      expect(compose, key).toMatch(new RegExp(`^\\s+${key}: \\$\\{${key}(:-[^}]*)?\\}$`, 'm'));
    }
  });

  it('.env.example keeps comments on their own line (R2-2)', () => {
    const example = readFileSync('.env.example', 'utf8');
    const inline = example.split('\n').filter((l) => /^[A-Z][A-Z0-9_]+=.*\S.*\s#/.test(l) || /^[A-Z][A-Z0-9_]+=\s*#/.test(l));
    expect(inline).toEqual([]);
  });

  it('image: non-root user, production dependencies only, no .env or secrets copied', () => {
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('npm ci --omit=dev');
    expect(dockerfile).not.toMatch(/COPY \.env/);
    expect(dockerfile).not.toMatch(/COPY \. /);
    expect(dockerignore).toContain('.env');
    expect(dockerignore).toContain('data/');
  });

  it('git ignores .env, data, backups and build output', () => {
    for (const p of ['.env', 'data/', 'backups/', 'node_modules/', 'dist/']) expect(gitignore).toContain(p);
  });
});
