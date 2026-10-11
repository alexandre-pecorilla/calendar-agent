# calendar-agent

A Slack bot that answers one question, in English or French: **when is the owner available?**
It reads free/busy information from the owner's Cal.com account and replies in the asker's
language and timezone. It never books anything and never shows what is on the calendar.

One instance per person: the owner's name, the bot's name and every key come from `.env`.
Current status and what was verified: `STATUS.md`.

## Table of contents

- [Architecture at a glance](#architecture-at-a-glance)
- [What it will and will not do](#what-it-will-and-will-not-do)
- [Project layout](#project-layout)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Make commands](#make-commands)
- [Documentation](#documentation)
- [License](#license)

## Architecture at a glance

One Node 24 process in one hardened container (non-root, read-only root filesystem,
capabilities dropped), one SQLite file in a Docker volume, published on loopback and the
host's Tailscale IP only.

- **Pipeline** (`src/pipeline/answer.ts`): question → sanitise → DeepSeek call 1 (JSON
  interpretation, schema-validated) → Cal.com busy-times of the calendars toggled "Check for
  conflicts" + the default schedule → free windows → deterministic English/French rendering →
  DeepSeek call 2 (phrasing, verified token by token) → reply. The same function serves Slack,
  the admin sandbox and `make ask`.
- **Slack** (`src/slack/`): Bolt in Socket Mode (outbound only). Replies in DMs, in a thread
  under @mentions, ephemerally to the slash command. `single` mode: one workspace with a pasted
  bot token. `multi` mode: the OAuth installer for several workspaces.
- **Admin** (`src/admin/`): password-protected pages for the query log, settings (keys
  encrypted at rest), connected workspaces and a sandbox that runs the exact pipeline.
- **Security** (`docs/architecture/security.md`): the model has no tools; the Cal.com client is
  GET-only with a frozen path allowlist; user text reaches only the first model call; replies
  are verified before posting; logs carry no content.

## What it will and will not do

| Will | Will not |
| --- | --- |
| Say when the owner is free, as windows, in the asker's timezone with the zone named | Show meeting titles, attendees or reasons (it never has them) |
| Understand EN and FR, any grammatical person, aliases, durations, exclusions, "Paris time" | Book, hold, move or cancel anything |
| Answer "outside usual hours" or "does not take meetings that day" from the owner's schedule | Look further than the horizon (4 weeks) or into the past |
| Refuse other people's calendars and the asker's own, in one fixed line | Answer anything unrelated to availability |

## Project layout

See `docs/development/repository-layout.md`.

## Prerequisites

Docker with Compose v2; Node 24 on the host for tests and the CLI; a Cal.com account with
calendars connected and toggled under "Check for conflicts"; a DeepSeek API key; a Slack
workspace where you can create apps. For `multi` mode, an HTTPS address reachable by your
browser (a Tailscale Serve mapping works).

## Setup

```bash
make setup          # .env from the template + host dependencies
make key-generate   # MASTER_KEY and SLACK_STATE_SECRET to paste into .env
# fill .env (comments inside explain every variable)
make manifest       # renders manifest.json → create the Slack app from it
make build && make up
make status         # health: slackConnected, workspaces
```

Full guide, both install modes, troubleshooting: `DEPLOYMENT.md`.

## Make commands

`make help` prints them all. Setup: `env`, `key-generate`, `install`, `setup`, `manifest`.
Run: `build`, `up`, `down`, `restart`, `rebuild`, `logs`, `ps`, `shell`, `status`.
Data: `db-backup`, `db-restore`, `db-shell`. Checks: `ask` (and `ask-host`),
`calcom-check`, `deepseek-check`, `test`, `test-live`, `lint`, `typecheck`,
`compile`, `ports-check`, `secrets-scan`, `audit`, `security-check`, `docs-check`,
`check`.

## Documentation

Index: `docs/README.md`. End-user guides to share with colleagues: `docs/user-guide.md`
(English) and `docs/guide-utilisateur.md` (French). Planning record: `scopes_of_work/`,
`action_plans/`, `testing_plans/`; evidence of every test step in `docs/testing/evidence/`;
review rounds in `docs/reviews/`.

## License

MIT, see `LICENSE`. Each person runs their own instance with their own keys;
nothing in this repository is specific to one owner.
