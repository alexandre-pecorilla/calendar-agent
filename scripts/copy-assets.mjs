#!/usr/bin/env node
/** Copy non-TypeScript runtime assets into dist/ after `tsc` (migrations, prompts, admin static files). */
import { cpSync, mkdirSync } from 'node:fs';

const pairs = [
  ['src/db/migrations', 'dist/db/migrations'],
  ['src/llm/prompts', 'dist/llm/prompts'],
  ['src/admin/static', 'dist/admin/static'],
];
for (const [from, to] of pairs) {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}
console.log('assets copied');
