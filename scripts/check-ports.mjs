#!/usr/bin/env node
/**
 * Verify the configured port is free on every publish address (adapted from
 * an earlier internal project scripts/check-ports.mjs). A port already held by our own running
 * container is not a collision.
 */
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function readEnvFile(path = '.env') {
  const text = await readFile(path, 'utf8').catch(() => {
    throw new Error(`Cannot read ${path}. Run 'make env' first.`);
  });
  const env = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/\s+#.*$/, '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return env;
}

function probe(host, port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE' ? 'in-use' : `error:${err.code}`));
    server.listen(port, host, () => server.close(() => resolve('free')));
  });
}

async function ownContainerHolds(port, project) {
  try {
    const { stdout } = await exec('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Ports}}']);
    return stdout.split('\n').some((l) => l.includes(`:${port}->`));
  } catch {
    return false;
  }
}

const env = await readEnvFile();
const port = Number(env.APP_PORT ?? 8400);
const project = env.COMPOSE_PROJECT_NAME ?? 'calendar-agent';
const addresses = (env.APP_BIND_ADDRESSES ?? '127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean);
if (addresses.length > 2) {
  console.error(`FAIL APP_BIND_ADDRESSES lists ${addresses.length} addresses; one or two are supported.`);
  process.exit(1);
}
let bad = 0;
for (const host of addresses) {
  const result = await probe(host, port);
  if (result === 'free') console.log(`ok   ${host}:${port} free`);
  else if (result === 'in-use' && (await ownContainerHolds(port, project))) console.log(`ok   ${host}:${port} held by our own container`);
  else {
    console.error(`FAIL ${host}:${port} ${result}`);
    if (result === 'error:EADDRNOTAVAIL') console.error(`     ${host} is not an address of this machine right now (Tailscale down or not up yet?): check 'tailscale status' and retry, or remove it from APP_BIND_ADDRESSES.`);
    bad++;
  }
}
process.exit(bad ? 1 : 0);
