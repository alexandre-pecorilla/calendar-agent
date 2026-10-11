#!/usr/bin/env node
/**
 * Fail if anything that looks like a real secret is tracked by git.
 * Ported from an earlier internal project (scripts/scan-secrets.mjs): committed-code half of the
 * "secrets never in code or logs" rule. Scope: files git tracks (or, before
 * the first commit, files git would add).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'Slack app-level token', re: /\bxapp-[0-9A-Za-z-]{10,}/ },
  { name: 'Cal.com live API key', re: /\bcal_live_[0-9a-f]{16,}/ },
  { name: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    name: 'hardcoded credential assignment',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'][^"'\n]{12,}["']/i,
  },
];
const ALLOW = [/^package-lock\.json$/, /^docs\/testing\/evidence\//];

let files;
try {
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
} catch {
  console.error('scan-secrets: not a git repository');
  process.exit(2);
}
let failures = 0;
for (const file of files) {
  if (ALLOW.some((re) => re.test(file))) continue;
  let text;
  try {
    if (statSync(file).size > 2_000_000) continue;
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split('\n').length;
      console.error(`${file}:${line}: looks like a ${rule.name}`);
      failures++;
    }
  }
}
if (failures) {
  console.error(`scan-secrets: ${failures} finding(s).`);
  process.exit(1);
}
console.log(`scan-secrets: ${files.length} files clean.`);
