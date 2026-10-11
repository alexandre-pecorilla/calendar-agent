import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const ROOT = resolve('.');
const run = (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) =>
  exec(file, args, { cwd: opts.cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...opts.env } }).then(
    (r) => ({ code: 0, ...r }),
    (err: { code?: number; stdout: string; stderr: string }) => ({ code: err.code ?? 1, stdout: err.stdout, stderr: err.stderr }),
  );

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

/** The host-side scripts and CLIs read .env the way the app does: comments stripped, one-line errors (R2-2, R2-4). */
describe('check-ports', () => {
  it('strips inline comments and quotes, and refuses more than two addresses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-ports-'));
    const port = await freePort();
    writeFileSync(join(dir, '.env'), `APP_PORT=${port} # the port\nAPP_BIND_ADDRESSES="127.0.0.1" # loopback only\nCOMPOSE_PROJECT_NAME=calendar-agent-test\n`);
    const ok = await run('node', [join(ROOT, 'scripts/check-ports.mjs')], { cwd: dir, env: {} });
    expect(ok.code, ok.stderr + ok.stdout).toBe(0);
    expect(ok.stdout).toContain(`ok   127.0.0.1:${port} free`);
    writeFileSync(join(dir, '.env'), `APP_PORT=${port}\nAPP_BIND_ADDRESSES=127.0.0.1,10.0.0.1,10.0.0.2\n`);
    const bad = await run('node', [join(ROOT, 'scripts/check-ports.mjs')], { cwd: dir, env: {} });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/one or two/);
  });
});

describe('manifest CLI', () => {
  it('renders from the identity variables alone and fails with one line, no values, on a bad configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-manifest-'));
    const tsx = join(ROOT, 'node_modules/.bin/tsx');
    const ok = await run(tsx, [join(ROOT, 'src/cli/manifest.ts')], { cwd: dir, env: { OWNER_NAME: 'Émilie Dupont' } });
    expect(ok.code, ok.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { display_information: { name: string } };
    expect(manifest.display_information.name).toBe('emilie-dupont-calendar-agent');
    const bad = await run(tsx, [join(ROOT, 'src/cli/manifest.ts')], { cwd: dir, env: { OWNER_NAME: 'Alex', INSTALL_MODE: 'multi', PUBLIC_BASE_URL: 'http://plain.example' } });
    expect(bad.code).toBe(2);
    expect(bad.stderr.trim()).toBe('INSTALL_MODE=multi requires an https:// PUBLIC_BASE_URL.');
    expect(bad.stderr).not.toContain('plain.example');
  }, 30_000);
});

describe('Makefile dry runs', () => {
  it('make -n rebuild and db-shell only print (no inline $(MAKE) chains, R3-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-make-n-'));
    writeFileSync(join(dir, 'x.env'), 'APP_PORT=8412\n');
    const r = await run('make', ['-n', '-f', join(ROOT, 'Makefile'), 'rebuild', 'SKIP_CHECK=1', 'COMPOSE=echo RAN', `ENV_FILE=${join(dir, 'x.env')}`], { cwd: ROOT, env: {} });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('echo RAN up -d --force-recreate');
    expect(r.stdout.split('\n').some((l) => l.startsWith('RAN '))).toBe(false);
    const sh = await run('make', ['-n', '-f', join(ROOT, 'Makefile'), 'db-shell', 'COMPOSE=echo RAN', `ENV_FILE=${join(dir, 'x.env')}`], { cwd: ROOT, env: {} });
    expect(sh.code, sh.stderr).toBe(0);
    expect(sh.stdout).toContain('sqlite3 $(ls -t backups/*.db | head -1)');
    expect(sh.stdout.split('\n').some((l) => l.startsWith('RAN '))).toBe(false);
  });
});

describe('Makefile .env reading', () => {
  it('ignores a trailing comment after APP_PORT when building the status URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-make-'));
    writeFileSync(join(dir, 'x.env'), 'APP_PORT=8411 # host port\nAPP_BIND_ADDRESSES="127.0.0.1, 100.64.0.9" # two\n');
    const r = await run('make', ['-n', '-f', join(ROOT, 'Makefile'), 'status', `ENV_FILE=${join(dir, 'x.env')}`], { cwd: ROOT, env: {} });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('http://127.0.0.1:8411/health');
    const up = await run('make', ['-n', '-f', join(ROOT, 'Makefile'), 'up', `ENV_FILE=${join(dir, 'x.env')}`], { cwd: ROOT, env: {} });
    expect(up.stdout).toContain('APP_PUBLISH_2=100.64.0.9');
    expect(up.stdout).toContain('compose.publish-2.yml');
  });
});
