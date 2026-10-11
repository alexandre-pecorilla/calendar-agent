# CLAUDE.md — calendar-agent

Project rules, binding for every Claude Code session. Extracted from
`scopes_of_work/alex-calendar-agent_scope.md` (APPROVED v3). Once the build is
accepted, this file and `docs/` are authoritative; the scope and plans are history.

## 1. What this is

A Slack bot answering one question in English or French: *when is the owner
available?* Source of truth: the owner's Cal.com account (busy-times of the
calendars toggled "Check for conflicts" + the default schedule). One instance per
person; the owner's identity comes from `.env`, never from code.

## 2. Hard constraints (never relax)

- **Free/busy only.** The only calendar data in the system is busy intervals and
  the schedule. No titles, attendees, locations, descriptions. The `source` field
  of Cal.com busy-times is dropped at parse time.
- **Read only.** No booking, holds, reschedules, cancellations. The Cal.com client
  (`src/calcom/client.ts`) is GET-only with a frozen path allowlist; a repo test
  enforces it.
- **The LLM has no tools.** Neither DeepSeek call declares functions. User text
  reaches only the parse call; its output is schema-validated; the phrase call
  receives code-generated strings only; replies are verified before posting.
- **No reasons.** The bot never says why the owner is busy. Allowed qualifiers:
  "outside the owner's usual hours", "does not take meetings that day".
- **Nothing hardcoded about the owner.** `OWNER_NAME`, `OWNER_ALIASES`, `BOT_NAME`
  only. `tests/repo/no-owner-literal.test.ts` fails on a literal.
- **Logs contain no content.** Question and answer text live in SQLite only.
- **Secrets** live in `.env` (mode 600, gitignored) or encrypted in the database.
  Never printed, never returned by a route, masked in the admin.
- **Machine discipline.** This directory only. Tailscale, ufw and other projects are
  never touched by the app or by a session.

## 3. Stack

Node 24, TypeScript (ESM, strict), Bolt for JavaScript in Socket Mode,
`@slack/oauth` for the multi-workspace installer, Fastify for the admin and OAuth
routes, `node:sqlite` (built in, no native build), luxon, zod, `openai` SDK against
DeepSeek (`deepseek-flash`, thinking on at effort low for the parse call, off for
the phrase call), pino. Docker Compose, one
service, one volume, hardened container (non-root, read-only rootfs, caps dropped).

## 4. Conventions

- `make <verb>` for everything (`make help`). `make check` before every commit.
- Documentation is a deliverable: a change ships with its docs updated in the same
  commit. Index in `docs/README.md`.
- Tests: `tests/unit` (pure), `tests/integration` (mocks, temp DB),
  `tests/repo` (hygiene guards), `tests/live` (real services, `make test-live`).
  "Now" is always injected; no test reads the wall clock.
- Commit messages: `S<n>: …`, `T<n>: …`, `R<n>: …`, `docs: …`, `fix: …`.
- Language: code and docs in English; user-facing bot text in EN and FR.

## 5. Documentation map

`docs/README.md` indexes everything. Architecture per concern in `docs/architecture/`,
development conventions in `docs/development/`, user guides `docs/user-guide.md` (EN) and
`docs/guide-utilisateur.md` (FR), installation in `DEPLOYMENT.md`, state in `STATUS.md`.

## 6. Planning workflow

Scope (`scopes_of_work/`) → action plan (`action_plans/`) → testing plan
(`testing_plans/`) → build, each phase approved by the owner. Review rounds
R1–R3 (functional) and R4 (security) close a build; reports in `docs/reviews/`.

## 7. Publishing (binding since 2026-10-11)

The original build history held the owner's client calendar addresses and
infrastructure details, so it was deleted; the history starts at the public
1.0.0 commit, and commit hashes cited in older documents no longer exist. Rules:

- One branch, `main`, the same locally and on GitHub:
  `make check` → commit → `git push`. Never `--force`, never rewrite pushed
  history.
- Before every push, nothing personal may enter the tree: no e-mail address,
  tailnet host name, Tailscale address, workspace id or client name. Guards:
  `tests/repo/no-owner-literal.test.ts` (generic patterns, product files) and
  `scripts/check-private-words.mjs` (the owner's real terms, listed in the
  gitignored `.private-words`, checked in every file and unpushed commit
  message by `make check` and the pre-push hook; `make hooks` installs it on a
  new clone). Never print, copy or commit the contents of `.private-words`.
  The example owner is "Alex"; the only real name in the tree is the copyright
  holder in `LICENSE`.
