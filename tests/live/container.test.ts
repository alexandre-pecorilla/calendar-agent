import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Live container checks (the running `calendar-agent-app-1`): hardening as
 * applied by Docker, published addresses, and no content in the logs after a
 * sandbox question. Skipped when the container is not running.
 */
function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}
let running = false;
try {
  running = sh('docker', ['inspect', '-f', '{{.State.Running}}', 'calendar-agent-app-1']) === 'true';
} catch {
  running = false;
}

describe.skipIf(!running)('container', () => {
  it('runs non-root with a read-only rootfs, dropped capabilities, no new privileges and limits', () => {
    const out = sh('docker', ['inspect', '-f', '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.RestartPolicy.Name}}', 'calendar-agent-app-1']);
    expect(out).toMatch(/^node true \[ALL\] \[no-new-privileges:true\] \d+ \d+ unless-stopped$/);
    const [, , , , mem, pids] = out.split(' ');
    expect(Number(mem)).toBeGreaterThan(0);
    expect(Number(pids)).toBeGreaterThan(0);
  });

  it('publishes only loopback and private addresses, never a wildcard', () => {
    const bindings = JSON.parse(sh('docker', ['inspect', '-f', '{{json .HostConfig.PortBindings}}', 'calendar-agent-app-1'])) as Record<string, Array<{ HostIp: string; HostPort: string }>>;
    const ips = Object.values(bindings).flat().map((b) => b.HostIp);
    expect(ips.length).toBeGreaterThan(0);
    for (const ip of ips) expect(ip, ip).toMatch(/^(127\.|100\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
  });

  it('writes no question or answer text to the container logs', async () => {
    const port = process.env.APP_PORT ?? '8400';
    const password = process.env.ADMIN_PASSWORD ?? '';
    if (!password) return;
    const marker = `canary-${Date.now()}`;
    const login = await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(password)}` });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const page = await (await fetch(`http://127.0.0.1:${port}/sandbox`, { headers: { cookie } })).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
    await fetch(`http://127.0.0.1:${port}/sandbox`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: `_csrf=${csrf}&question=${encodeURIComponent(`is the owner free Monday? ${marker}`)}&tz=UTC&lang=en&now=2026-10-09T12:00` });
    const logs = sh('docker', ['logs', '--since', '2m', 'calendar-agent-app-1']);
    expect(logs).not.toContain(marker);
    expect(logs).not.toContain('is the owner free');
    expect(logs).toContain('question answered');
  });
});
