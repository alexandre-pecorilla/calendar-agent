import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard (CLAUDE.md §2, action plan §6.2): the Cal.com module
 * contains one HTTP method literal, GET, and no API path outside the frozen
 * allowlist; nothing else under src/ opens an HTTP connection. The runtime
 * check (`ALLOWED_SET.has(path)` in the client) is the control; this guard
 * keeps a write endpoint from being added quietly (R4-6: spellings in any
 * case, concatenations and query strings are caught too).
 */
const calcomDir = join(process.cwd(), 'src', 'calcom');
const calcomFiles = readdirSync(calcomDir).filter((f) => f.endsWith('.ts'));
const sources = Object.fromEntries(calcomFiles.map((f) => [f, readFileSync(join(calcomDir, f), 'utf8')]));
const ALLOWED = ['/v2/me', '/v2/calendars', '/v2/schedules/default', '/v2/calendars/busy-times'];
const allSources = (readdirSync('src', { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(join('src', f), 'utf8')] as const);

describe('src/calcom allowlist', () => {
  it('every method: value is the literal GET, and no write verb is spelled in any case', () => {
    for (const [f, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/\bmethod\s*:\s*([^,\n}]+)/g)) expect(m[1]!.trim(), `${f}: method ${m[1]}`).toBe("'GET'");
      expect(src, `${f} mentions a write verb`).not.toMatch(/['"\`](post|put|patch|delete|options|head)['"\`]/i);
    }
  });
  it('every /v2/ path anywhere in the module, quoted or not, is on the allowlist (no query, no traversal)', () => {
    for (const [f, src] of Object.entries(sources)) {
      const paths = [...src.matchAll(/\/v2\/[A-Za-z0-9/_.?=&%-]*/g)].map((m) => m[0].replace(/[.,;:]+$/, ''));
      if (f === 'client.ts') expect(paths.length, 'client.ts declares the paths').toBeGreaterThan(0);
      for (const p of paths) expect(ALLOWED, `${f} references ${p}`).toContain(p);
    }
  });
  it('declares exactly the four allowlisted paths and one fetch', () => {
    const client = sources['client.ts']!;
    for (const p of ALLOWED) expect(client).toContain(`'${p}'`);
    expect(client).toContain('fetchImpl(url, {');
    expect(client.match(/fetchImpl\(/g)).toHaveLength(1);
  });
  it('nothing outside src/calcom/client.ts opens an HTTP connection itself', () => {
    for (const [f, src] of allSources) {
      if (f === 'calcom/client.ts') continue;
      expect(src, `${f} performs HTTP`).not.toMatch(/\bfetch\s*\(|new Request\s*\(|\bhttps?\.request\s*\(|\bhttps?\.get\s*\(|from ['"]undici['"]|from ['"]axios['"]|from ['"]node-fetch['"]/);
    }
  });
});
