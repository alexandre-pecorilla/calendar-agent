#!/usr/bin/env node
/**
 * Fail if a private term appears in anything about to be published
 * (`make private-words-check`, part of `make check`, also the pre-push hook).
 * The terms live in `.private-words` at the repository root: gitignored, one
 * term per line, `#` for comments, matched case-insensitively as plain text.
 * Scope: file names and contents of the files git tracks (or would add), and
 * the messages of commits not yet pushed. Without the list (CI, a fresh clone)
 * the check is skipped. Findings name the place and the term's line number in
 * the list, never the term itself, so the output can be pasted anywhere.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const LIST = '.private-words';
const ALLOW = new Set(['LICENSE']); // the copyright holder is the one real name in the tree

if (!existsSync(LIST)) {
  console.log(`private-words: no ${LIST}, skipped.`);
  process.exit(0);
}
const terms = readFileSync(LIST, 'utf8')
  .split('\n')
  .map((line, i) => ({ n: i + 1, term: line.trim().toLowerCase() }))
  .filter((t) => t.term && !t.term.startsWith('#'));
if (!terms.length) {
  console.log(`private-words: ${LIST} has no terms yet, skipped.`);
  process.exit(0);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
let files;
let commits;
try {
  files = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);
  commits = git('rev-list', 'HEAD', '--not', '--remotes').split('\n').filter(Boolean);
} catch {
  console.error('private-words: not a git repository');
  process.exit(2);
}

const findings = [];
const scan = (where, text) => {
  const lines = text.toLowerCase().split('\n');
  lines.forEach((line, i) => {
    for (const t of terms) if (line.includes(t.term)) findings.push(`${where}:${i + 1}: term on line ${t.n} of ${LIST}`);
  });
};

for (const file of files) {
  if (ALLOW.has(file)) continue;
  for (const t of terms) if (file.toLowerCase().includes(t.term)) findings.push(`${file}: file name contains the term on line ${t.n} of ${LIST}`);
  let text;
  try {
    if (!statSync(file).isFile()) continue;
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted from the working tree, still in the index
  }
  if (text.includes('\0')) continue; // binary
  scan(file, text);
}
for (const sha of commits) scan(`commit ${sha.slice(0, 7)} message`, git('log', '-1', '--format=%B', sha));

if (findings.length) {
  for (const f of findings) console.error(f);
  console.error(`private-words: ${findings.length} finding(s). Remove them before pushing.`);
  process.exit(1);
}
console.log(`private-words: ${terms.length} terms, ${files.length} files, ${commits.length} unpushed commit(s) clean.`);
