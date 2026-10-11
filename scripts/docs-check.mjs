#!/usr/bin/env node
/**
 * Documentation accuracy sweep (`make docs-check`): every Markdown file under
 * docs/ is listed in docs/README.md; every relative link or backticked path in
 * the docs resolves; every `make <target>` mentioned exists in the Makefile.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = process.cwd();
const mdFiles = [];
function walk(p) {
  for (const f of readdirSync(p)) {
    const full = join(p, f);
    if (statSync(full).isDirectory()) walk(full);
    else if (f.endsWith('.md')) mdFiles.push(full);
  }
}
walk(join(ROOT, 'docs'));
for (const f of ['README.md', 'DEPLOYMENT.md', 'CLAUDE.md', 'STATUS.md']) mdFiles.push(join(ROOT, f));

const problems = [];
const index = readFileSync(join(ROOT, 'docs/README.md'), 'utf8');
for (const f of mdFiles) {
  const rel = f.slice(ROOT.length + 1);
  if (rel.startsWith('docs/') && rel !== 'docs/README.md' && !/^docs\/(testing\/evidence|reviews)\//.test(rel)) {
    if (!index.includes(rel.slice('docs/'.length))) problems.push(`not indexed in docs/README.md: ${rel}`);
  }
}

const makefile = readFileSync(join(ROOT, 'Makefile'), 'utf8');
const targets = new Set([...makefile.matchAll(/^([a-zA-Z0-9_-]+):/gm)].map((m) => m[1]));
for (const f of mdFiles) {
  const text = readFileSync(f, 'utf8');
  const dir = dirname(f);
  for (const m of text.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    if (!existsSync(resolve(dir, target))) problems.push(`${f.slice(ROOT.length + 1)}: broken link ${target}`);
  }
  for (const m of text.matchAll(/`((?:\.\.?\/)?(?:src|docs|scripts|tests|scopes_of_work|action_plans|testing_plans)\/[A-Za-z0-9_./-]+)`/g)) {
    const p = m[1];
    if (/[*<>{}]/.test(p)) continue;
    const abs = p.startsWith('.') ? resolve(dir, p) : resolve(ROOT, p);
    if (!existsSync(abs)) problems.push(`${f.slice(ROOT.length + 1)}: path does not exist ${p}`);
  }
  // `make <target>` only where it is code: inline backticks or fenced blocks.
  const codeSpans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n'));
  for (const span of [...codeSpans, ...fenced]) {
    for (const m of span.matchAll(/(?:^|&&|;|\|)\s*make ([a-z][a-z0-9-]+)\b/g)) {
      if (!targets.has(m[1])) problems.push(`${f.slice(ROOT.length + 1)}: unknown make target "${m[1]}"`);
    }
  }
}
if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`docs-check: ${problems.length} problem(s).`);
  process.exit(1);
}
console.log(`docs-check: ${mdFiles.length} documents, ${targets.size} make targets, all links and paths resolve.`);
