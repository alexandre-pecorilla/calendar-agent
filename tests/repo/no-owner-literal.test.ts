import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Nothing about the owner is hardcoded (scope §20): the example owner's name,
 * any e-mail address, any tailnet host name and any Tailscale (CGNAT) address
 * must not appear in source, prompts, templates or static files. They may
 * appear in the planning documents, the evidence and the tests' fixtures only.
 */
const ROOTS = ['src', 'scripts', '.env.example', 'Dockerfile', 'docker-compose.yml', 'compose.publish-2.yml', 'Makefile'];
const LITERALS = [/\bAlex\b/, /\bAlexandre\b/, /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+/i, /\.ts\.net\b/i, /\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+\b/];
const ALLOW_FILES = new Set(['.env.example']); // the template shows an example owner on purpose

function walk(p: string, out: string[]): void {
  const st = statSync(p);
  if (st.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f), out);
  else out.push(p);
}

describe('no owner literal in the product', () => {
  it('src, scripts and deployment files name no owner, calendar, workspace or host', () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(r, files);
    const findings: string[] = [];
    for (const f of files) {
      if (ALLOW_FILES.has(f)) continue;
      const text = readFileSync(f, 'utf8');
      for (const re of LITERALS) if (re.test(text)) findings.push(`${f}: ${re}`);
    }
    expect(findings).toEqual([]);
  });
});
