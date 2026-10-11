# calendar-agent (`alex-calendar-agent`) — Action Plan

**Date:** 2026-10-09 · **Input:** `scopes_of_work/alex-calendar-agent_scope.md` (APPROVED v3) · **Companion:** `testing_plans/calendar-agent_testing_plan.md`
**Status:** DRAFT v1, awaiting the owner's go. **Execution mode:** autonomous, all steps at once, no owner intervention: each step Sn is followed by testing step Tn before Sn+1 starts; after S8/T8, review rounds R1, R2, R3 (independent, sequential) and R4 (security) run, then the closeout. The owner supplies everything listed in §11 before the go.

## 1. Scope

Build `calendar-agent`, a Slack bot answering "when is <owner> available?" in English or French from Cal.com free/busy data, with a password-protected web admin (query log, settings, workspaces, sandbox), distributable to colleagues as one instance per person. Hard limits from the scope: free/busy only, read only, no booking, no event details, no reasons beyond the schedule, enforced in code. Everything documented. Security is its own step (S7) and its own review round (R4).

## 2. Decisions locked (scope v3, owner-approved 2026-10-09)

| # | Decision |
| --- | --- |
| D1 | Cal.com API v2 with an API key is the only availability source; busy-times + default schedule; selected calendars only |
| D2 | Google free/busy semantics accepted as-is, verified empirically in T3 (matrix in Appendix C) |
| D3 | DeepSeek V4.1 Flash, model id `deepseek-flash`, thinking on at effort `low`, two calls (parse, phrase), no tools ever |
| D4 | Timezone: asker's Slack profile zone by default, a zone named in the question wins, label always present, fallback to the owner's schedule zone |
| D5 | No minimum window; 15-minute noise floor; duration in the question filters; horizon 4 weeks; past refused; 10-day listing cap |
| D6 | Entry points: DM, @mention (thread reply), slash command (ephemeral); stateless v1 |
| D7 | One name everywhere: `BOT_NAME` derived from `OWNER_NAME`; `OWNER_ALIASES` optional; nothing hardcoded, repo test enforces |
| D8 | Any grammatical person refers to the owner; other person or "me" gets a fixed reply; replies in third person |
| D9 | Admin: one password from env, sessions, four pages (Queries, Settings, Workspaces, Sandbox); queries kept forever; SQLite |
| D10 | Hosting: Docker Compose, one service, port 8400 published on 127.0.0.1 and the Tailscale IP; Tailscale Serve port 8445 for the OAuth redirect, command run by the owner |
| D11 | Install modes `single` (bot token in env) and `multi` (OAuth installer, an earlier internal project pattern); one instance per person |
| D12 | Documentation set per scope §22; EN and FR end-user guides |
| D13 | Node 24, TypeScript, Bolt for JavaScript (Socket Mode), `@slack/oauth`, Fastify for HTTP, better-sqlite3, luxon, zod, `openai` SDK against DeepSeek, pino |

## 3. Grounding: facts the build relies on (official docs, consulted via the documentation MCP server unless noted)

### 3.1 Cal.com API v2 (the documentation MCP server `cal-com`: API v2 reference, OpenAPI spec, AI-agents guide)

| Fact | Source |
| --- | --- |
| Auth header `Authorization: Bearer cal_live_…`; `cal-api-version` header required on every v2 call, omitted = 404; `2024-08-13` is the documented default | AI agents guide, Authentication |
| `GET /v2/schedules/default` requires `cal-api-version: 2024-06-11`; response `data` (nullable) = `{id, ownerId, name, timeZone, availability[{days[], startTime "HH:MM", endTime}], isDefault, overrides[{date, startTime, endTime}]}` | Schedules reference, OpenAPI |
| `GET /v2/calendars` → `data.connectedCalendars[]` each `{integration{name, slug, type…}, credentialId, primary, calendars[{externalId, name, email, primary, readOnly, isSelected, credentialId, delegationCredentialId}]}` plus `data.destinationCalendar` | Calendars reference, OpenAPI `ConnectedCalendarsOutput` |
| `GET /v2/calendars/busy-times?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&timeZone=<IANA>&calendar=<credentialId>,<externalId>` (repeat `calendar`; only the first comma separates) → `data[{start, end, source?}]`; `loggedInUsersTz` deprecated | Calendars reference, OpenAPI `BusyTimesOutput` |
| `GET /v2/me` for key verification | AI agents guide |
| API-key rate limit 120 requests per minute | AI agents guide, Rate limits |
| Cal.com reads Google through the free/busy API only; selected calendars are the "Check for conflicts" toggles | Help center, privacy page; event-types "checking for conflicts" |
| Event-type-specific conflict checking exists but is irrelevant here (we query calendars, not event types) | Help center |

### 3.2 Slack (the documentation MCP server `slack`: Bolt JS, Socket Mode, OAuth, manifests, methods, user object)

| Fact | Source |
| --- | --- |
| Socket Mode: app-level token (`xapp-`) with `connections:write`; no inbound URL; events and slash commands arrive over the WebSocket | Using Socket Mode |
| Manifest for Socket Mode: `settings.socket_mode_enabled: true`, `event_subscriptions.bot_events` without `request_url`, `slash_commands` without `url`; `features.app_home.messages_tab_enabled: true` and `messages_tab_read_only_enabled: false` so users can DM the bot | Socket Mode manifest example; manifest reference; Python Socket Mode guide (Messages tab) |
| Socket Mode apps cannot be listed in the Marketplace but can be installed into other workspaces through OAuth; an unlisted app needs OAuth handling to be installed anywhere but its home workspace | Using Socket Mode; App lifecycle & distribution |
| Bolt JS does not run OAuth on custom receivers; `@slack/oauth` (`InstallProvider`) is what Bolt uses under the hood and is the supported way to run the install flow from our own HTTP server | Bolt JS, Authenticating with OAuth |
| Install flow needs `clientId`, `clientSecret`, `stateSecret`, bot `scopes`, an `installationStore` (store, fetch, delete), and the redirect URL registered under OAuth & Permissions | Bolt JS, Authenticating with OAuth |
| `app_mention` → reply in thread with `thread_ts ?? event.ts`; ephemeral messages (`chat.postEphemeral`, or `respond` with `response_type: ephemeral`) are the recommended default for slash commands; `message.im` for DMs | Interaction surfaces; chat.postEphemeral |
| Slash command and event handlers must acknowledge quickly (Slack's 3-second rule); the reply comes afterwards via `respond`/`say` | Bolt JS listeners (general Slack platform rule) |
| `users.info` (`users:read`) returns `tz` (IANA), `tz_label`, `tz_offset`, and `locale` with `include_locale: true` | User object reference; users.info |
| Bot scopes needed: `app_mentions:read`, `chat:write`, `commands`, `im:history`, `im:read`, `im:write`, `users:read` | Scopes reference |
| Admin approval may be required per workspace; the installer must be allowed to install apps | App lifecycle & distribution |

### 3.3 DeepSeek (official docs api-docs.deepseek.com, fetched 2026-10-09; cross-checked with an earlier internal project `apps/server/src/llm/providers.ts` live-verified 2026-09-11 and another internal tool `flask_app/helpers.py`)

| Fact | Source |
| --- | --- |
| OpenAI-compatible base URL `https://api.deepseek.com`; model id `deepseek-flash` (evergreen alias for V4.1 Flash) | Pricing page; an earlier internal project providers.ts |
| Thinking is a request parameter: `thinking: {type: "enabled"}` plus top-level `reasoning_effort` with values `low`, `high`, `max`; the endpoint silently accepts unknown effort values, so the value is validated locally | Reasoning model guide; an earlier internal project providers.ts |
| JSON mode: `response_format: {type: "json_object"}`; the word "json" and an example of the structure must appear in the prompt; set `max_tokens` to avoid truncation; the API may occasionally return empty content (retry once, then fall back) | JSON output guide |
| Pricing `deepseek-flash`: input cache miss $0.15 / $0.30 per 1M (off-peak / peak), cache hit $0.003 / $0.006, output $0.60 / $1.20; peak = 01:00–04:00 and 06:00–10:00 UTC Mon–Fri excluding Chinese public holidays | Pricing page |
| DeepSeek control-token framing (`<｜…｜>`) must be neutralized in untrusted text | an earlier internal project `security/control-tokens.ts` |
| The `openai` npm SDK is a proven client for this endpoint | an earlier internal project `apps/server/package.json` |

## 4. Reuse map (read-only sources on this machine)

| Reused from | What | How |
| --- | --- | --- |
| an earlier internal project `apps/server/src/crypto/envelope.ts` + `secret.ts` | AES-256-GCM envelope encryption, master key parsing with placeholder refusal, `Secret` wrapper that never prints | Ported verbatim with renamed env var `MASTER_KEY`; tests ported |
| an earlier internal project `apps/server/src/security/control-tokens.ts` | `neutralizeControlTokens()` | Ported verbatim |
| an earlier internal project `scripts/scan-secrets.mjs`, `scripts/check-ports.mjs` | Committed-secret scan; port collision check against `.env` | Ported, adapted to our variables |
| an earlier internal project `Makefile` | `help` target with `##` comments, `env`, `key-generate`, `setup`, `build`, `up`, `down`, `restart`, `logs`, `ps`, `shell`, `test`, `lint`, `typecheck`, `check`, `ports-check`, `secrets-scan`, `audit`, `security-check` | Same verbs, same style |
| an earlier internal project `Dockerfile`, `docker-compose.yml` | Multi-stage `node:24-alpine`, non-root runtime, healthcheck via `node -e fetch`, loopback-bound published port | Adapted; two published addresses |
| an earlier internal project `apps/server/src/auth/service.ts` | Opaque session tokens hashed at rest, DB-backed lockout (5 attempts / 15 min) | Pattern reused for password login (scrypt instead of TOTP) |
| an earlier internal project `apps/server/src/slack/workspaces.ts` + `docs/architecture/slack.md` | One app for every workspace, single-use time-bounded state, mobile double-callback pitfall, secret regeneration note | Behaviour reproduced via `@slack/oauth`; pitfalls go into `DEPLOYMENT.md` |
| an earlier internal project `apps/server/src/llm/providers.ts` | DeepSeek request shape (`thinking` + `reasoning_effort`), effort validation | Request shape reused |
| another internal tool `flask_app/helpers.py` | Effort levels and model notes for V4.1 Flash | Cross-check only |
| the documentation MCP server / another internal tool `README.md`, `DEPLOYMENT.md`, `STATUS.md`, `CLAUDE.md` | Document structure: table of contents, architecture at a glance, project layout, prerequisites, setup, make commands; STATUS dated entries with commit hashes; CLAUDE sections | Same structure |
| an earlier internal project `docs/README.md`, `docs/development/testing.md` | Docs index style; suites and conventions | Same style |
| an earlier internal project `tests/repo/*.test.ts` | Repository-hygiene tests (ports, structural guards) | Same idea: naming guard, GET-only guard, scope guard |

Deliberately not ported: PostgreSQL/drizzle (SQLite), TOTP (password), MCP, PWA, module SDK, streaming.

## 5. Architecture

One Node process in one container, three concerns:

1. **Pipeline** (`src/pipeline/answer.ts`): `answerQuestion(ctx, text) → Reply`. Input context: asker id, display name, timezone, locale, entry point, optional "now" override. Steps: sanitize → rate limit → call 1 (parse) → validate → availability → format → call 2 (phrase) → verify → log → return. The same function serves Slack and the sandbox.
2. **Slack** (`src/slack/*`): Bolt `App` with `SocketModeReceiver`, custom `authorize` reading our encrypted installation store; handlers for `message.im`, `app_mention`, the slash command; `users.info` lookup cached 1 hour; install flow via `@slack/oauth` mounted on the admin HTTP server (`/slack/install`, `/slack/oauth_redirect`) in `multi` mode only.
3. **Admin** (`src/admin/*`): Fastify on port 8400: login, Queries, Settings, Workspaces, Sandbox, `/health`; server-rendered HTML with an escaping helper, one small static script for the sandbox; CSRF tokens, security headers, rate-limited login.

Cross-cutting: `src/config` (zod-validated env, identity derivation), `src/db` (better-sqlite3, migrations, repositories), `src/crypto` (envelope), `src/calcom` (allowlisted client + cache), `src/availability` (pure computation and formatting), `src/llm` (DeepSeek client, prompts, parse/phrase/verify), `src/logging` (pino with redaction, no content), `src/security` (control tokens, input caps).

## 6. Security architecture (binding; S7 verifies, R4 reviews)

1. **The LLM has no tools.** Neither call declares functions or tools. The model can only return JSON (call 1) or text (call 2). There is no path from model output to any HTTP call.
2. **Cal.com surface allowlist.** `src/calcom/client.ts` exposes exactly four functions: `me()`, `calendars()`, `defaultSchedule()`, `busyTimes()`. The HTTP method is the literal `GET` in one place; paths come from a frozen allowlist; the client refuses anything else. A repository test fails on any other method or path under `src/calcom`, and an integration test with a mock server asserts only allowlisted paths are ever hit. Writes are impossible by construction, whatever the prompt says.
3. **User text reaches only call 1.** Its output is validated by zod: enum intents, ISO datetimes, weekday enums, language enum, IANA zone checked against `Intl.supportedValuesOf('timeZone')`. Anything else becomes a fixed clarification reply. Call 2 receives only code-generated strings (formatted windows, intent, language, label); the raw question never reaches it.
4. **Output verification.** Every time/date token in the call-2 reply must exist in the formatted set the code produced, and the reply must be under a length cap; otherwise the deterministic template is sent. Fixed replies never go through the model.
5. **Input hygiene.** Question capped at 500 characters, mention markup stripped, control tokens neutralized (an earlier internal project chokepoint), non-text ignored, bot and subtype messages ignored.
6. **Abuse limits.** Per user 10 questions/minute, per workspace 60/minute, global 100/minute (under Cal.com's 120), daily budget (default 2,000 questions) after which a fixed "over capacity" reply is sent and the admin shows a banner.
7. **Secrets.** Env file mode 600; Cal.com and DeepSeek keys and Slack bot tokens encrypted at rest (AES-256-GCM envelope, master key only in env); no route ever returns a secret; masked in the admin; pino redaction paths; `scan-secrets` gate; `.env` gitignored.
8. **Admin.** scrypt password hash computed at startup from `ADMIN_PASSWORD` (never logged); opaque session token hashed at rest, 30-day TTL, `HttpOnly`, `SameSite=Lax`; lockout 5 failures / 15 minutes stored in DB; CSRF double-submit token on every form; CSP `default-src 'self'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`; login rate limit; sandbox and every page behind auth.
9. **Network.** Published only on `127.0.0.1` and the Tailscale IP; no public interface; Socket Mode outbound only; the OAuth redirect is tailnet-only HTTPS via Tailscale Serve; OAuth state single-use and time-bounded.
10. **Container.** Non-root user, `read_only: true` root filesystem with `tmpfs` for `/tmp`, `cap_drop: [ALL]`, `security_opt: no-new-privileges:true`, memory and pids limits, log rotation, healthcheck.
11. **Logs contain no content.** Structured events with ids, durations, counts, error codes. Question and answer text live only in the SQLite file.
12. **Dependencies.** `npm audit --audit-level=high` gate, pinned lockfile, minimal dependency set.
13. **Prompt-injection corpus.** EN/FR attack prompts (instruction override, booking/deleting requests, key exfiltration, role-framing tokens, JSON escape attempts, other-person pivots) run through the real pipeline in T4 and T7; the only acceptable outcomes are a normal availability answer or a fixed reply.
14. **Residual risks, documented.** No egress firewall inside the container; Slack timezone staleness; ephemeral delivery not guaranteed; a compromised master key exposes stored tokens.

## 7. Repository layout

```
Is-Alex-Available/
  README.md  DEPLOYMENT.md  STATUS.md  CLAUDE.md  LICENSE(none)  .gitignore
  Makefile  Dockerfile  docker-compose.yml  .env.example  manifest.template.json
  package.json  package-lock.json  tsconfig.json  vitest.config.ts  eslint.config.js
  scopes_of_work/  action_plans/  testing_plans/
  src/
    index.ts                      # boot: config → db → crypto → services → admin → slack
    config/env.ts                 # zod schema of every variable, derived values
    config/identity.ts            # OWNER_NAME → BOT_NAME slug, aliases, elision helper
    db/sqlite.ts  db/migrate.ts  db/migrations/0001_init.sql …
    db/repos/{queries,settings,installations,oauth_states,sessions,rate_limits}.ts
    crypto/envelope.ts  crypto/secret.ts
    security/control-tokens.ts  security/input.ts
    calcom/client.ts  calcom/types.ts  calcom/cache.ts
    availability/schedule.ts      # schedule → per-day working intervals (+overrides)
    availability/windows.ts       # busy subtraction, noise floor, merge, duration filter, caps
    availability/timezone.ts      # IANA validation, label derivation, Slack tz fallback
    availability/format.ts        # EN/FR dates, times, ranges, elision
    llm/deepseek.ts               # client, retries, cost accounting
    llm/parse.ts  llm/phrase.ts  llm/verify.ts
    llm/prompts/parse.{en,fr}.md  llm/prompts/phrase.md   # templates with {{placeholders}}
    pipeline/answer.ts  pipeline/fixed-replies.ts  pipeline/rate-limit.ts  pipeline/types.ts
    slack/app.ts  slack/handlers.ts  slack/authorize.ts  slack/installation-store.ts
    slack/install-routes.ts  slack/user-context.ts  slack/manifest.ts
    admin/server.ts  admin/auth.ts  admin/csrf.ts  admin/html.ts
    admin/routes/{login,queries,settings,workspaces,sandbox,health}.ts
    admin/static/sandbox.js  admin/static/admin.css
    logging/logger.ts
  scripts/check-ports.mjs  scripts/scan-secrets.mjs  scripts/render-manifest.mjs  scripts/ask.mjs
  tests/unit/…  tests/integration/…  tests/repo/…  tests/live/…  tests/fixtures/…
  docs/README.md
  docs/user-guide.md  docs/guide-utilisateur.md
  docs/architecture/{pipeline,availability,llm,slack,admin,data,security,configuration}.md
  docs/development/{repository-layout,testing,conventions,release}.md
  docs/testing/evidence/S1.md … S8.md     docs/reviews/R1.md … R4.md
```

## 8. Part 1 — The engine without Slack (S1 to S4)

Each step ends with: docs updated, `make check` green, a commit `S<n>: <title>`, then testing step T<n> (its evidence file committed as `T<n>: …`).

### S1 — Repository skeleton, toolchain, configuration, Docker, Makefile, git

- `git init`, `.gitignore` (`.env`, `data/`, `node_modules/`, `dist/`), first commit of the plans and scope.
- `package.json` (type module, Node 24 engines), TypeScript strict, ESLint, Prettier, vitest; dependencies: `@slack/bolt`, `@slack/oauth`, `@slack/web-api`, `fastify`, `@fastify/cookie`, `@fastify/formbody`, `@fastify/static`, `@fastify/rate-limit`, `better-sqlite3`, `luxon`, `zod`, `openai`, `pino`.
- `src/config/env.ts`: zod schema (Appendix A variables), `INSTALL_MODE` conditional requirements, derived `BOT_NAME` (slug rules, 32-char cap, validation), `OWNER_ALIASES` parsing, `APP_BIND_ADDRESSES` parsing. Fails closed with a precise message naming the variable, never its value.
- `src/config/identity.ts`: slugify (NFD strip accents, lowercase, `[^a-z0-9]+` → `-`, trim, append `-calendar-agent`), French elision (`d'` before vowel or mute h, `de` otherwise).
- `src/logging/logger.ts`: pino, redaction of every secret path, no `text`/`answer` fields ever.
- `Dockerfile` (multi-stage, non-root), `docker-compose.yml` (service `app`, volume `data` at `/data`, env file, two published addresses, hardening of §6.10, healthcheck on `/health`), `.env.example` fully commented, `Makefile` (verbs of §4), `scripts/check-ports.mjs`, `scripts/scan-secrets.mjs`.
- Minimal `src/index.ts` booting config + `/health` only.
- Docs: `README.md` skeleton, `docs/development/repository-layout.md`, `docs/architecture/configuration.md`, `CLAUDE.md` v1, `STATUS.md` first entry.
- Exit: `make build && make up` serves `/health` on both addresses; `make ports-check` passes; secrets scan clean.

### S2 — Storage and secrets

- SQLite via better-sqlite3 at `/data/calendar-agent.db`, WAL mode, migrations runner (numbered SQL files, applied at boot, recorded in `schema_migrations`).
- Tables: `queries`, `settings` (encrypted flag), `slack_installations` (token encrypted), `oauth_states`, `sessions`, `login_attempts`, `rate_limits`, `schema_migrations`.
- `crypto/envelope.ts` + `secret.ts` ported from an earlier internal project; `MASTER_KEY` validated at boot (32 bytes base64, placeholder refused).
- Settings service: typed get/set, encrypted values for `calcom_api_key`, `deepseek_api_key`; seeding rule: on boot, if a key is empty in the DB and present in env, import it encrypted (env value may then be removed).
- Query log repository with the columns of scope §11; `make db-backup` (copy with `sqlite3 .backup`), `make db-shell`.
- Docs: `docs/architecture/data.md`, `docs/architecture/security.md` (secrets section).
- Exit: migrations idempotent across restarts; a decrypted settings round trip works; the DB file is in the volume.

### S3 — Cal.com client and availability engine

- `calcom/client.ts`: allowlisted GET-only client (§6.2), headers from §3.1, timeouts, retry on 429/5xx with backoff, typed responses validated with zod, `source` dropped at parse time. `calcom/cache.ts`: calendars and default schedule cached 10 minutes; busy-times never cached.
- `availability/schedule.ts`: per-day working intervals from the schedule (weekday rules, overrides replacing a date, zone-aware via luxon).
- `availability/windows.ts`: subtract busy intervals, clip to "now" rounded up to 5 minutes, drop gaps < noise floor, merge, duration filter, horizon clip, listing cap (10 days), "whole day free" detection, outside-hours and no-hours classification for point questions.
- `availability/timezone.ts`: IANA validation, label from zone (city after the slash, underscores to spaces; abbreviation via Intl), fallback chain.
- `availability/format.ts`: EN (`Mon Oct 13`, `4:00 PM`, `to`), FR (`lundi 13 octobre`, `16h00`, `à`), ranges, per-day lines, elision.
- `make calcom-check`: live call to `/v2/me`, lists selected calendars and the schedule summary (ids and emails only).
- Docs: `docs/architecture/availability.md` (algorithm with worked example), `docs/architecture/calcom.md`? folded into availability.md to keep the set small.
- Exit: pure functions fully unit-tested with fixtures; live `calcom-check` passes with the owner's key.

### S4 — LLM layer, pipeline, fixed replies, CLI sandbox

- `llm/deepseek.ts`: `openai` SDK, base URL, model `deepseek-flash`, `thinking: {type: 'enabled'}`, `reasoning_effort: 'low'` (validated against `['low','high','max']`), `temperature: 0`, `max_tokens` 600 for parse and 400 for phrase, JSON mode for parse, one retry on empty content or network error, usage → cost with peak/off-peak detection (UTC windows of §3.3), 20-second timeout.
- `llm/parse.ts`: prompt template with `{{OWNER_NAME}}`, `{{ALIASES}}`, `{{NOW}}`, `{{ASKER_TZ}}`, `{{OWNER_TZ}}`, the word "json" and a full example; output schema `{intent: point|day|range|open|duration_only|other_person|self|off_topic|booking|help, range_start, range_end, point_time, excluded_weekdays[], duration_minutes, language: en|fr|other, timezone_override}`; zod validation; invalid → `clarify` fixed reply. Date-phrase conventions of scope §5.5 encoded in the prompt and unit-tested against a corpus.
- `llm/phrase.ts`: prompt receives intent, language, label, formatted lines; `llm/verify.ts`: token-set check and length cap, fallback to template.
- `pipeline/answer.ts` orchestrating everything, `fixed-replies.ts` (EN/FR texts of scope §5.4), `rate-limit.ts` (§6.6), query logging, error mapping (Cal.com down, DeepSeek down → "cannot check right now").
- `scripts/ask.mjs` + `make ask q="…" [tz=…] [lang=…] [now=…]`: the CLI sandbox used by T4.
- Docs: `docs/architecture/llm.md` (both prompts, schema, guardrails), `docs/architecture/pipeline.md`.
- Exit: the six question shapes answer correctly from the CLI in both languages; injection corpus yields only fixed or normal replies.

## 9. Part 2 — Admin, Slack, security, documentation (S5 to S8)

### S5 — Web admin

- Fastify server on `APP_PORT`, bound per `APP_BIND_ADDRESSES`; `/health` public; everything else behind session auth.
- `admin/auth.ts`: scrypt hash of `ADMIN_PASSWORD` at boot, `timingSafeEqual`, sessions table, lockout, logout; `admin/csrf.ts`; security headers; login rate limit.
- Pages: Queries (table, filters, detail), Settings (masked keys, "test connection" buttons calling `/v2/me` and a minimal DeepSeek completion, horizon, noise floor, rate limits, daily budget, read-only identity block), Workspaces (list, status line, "Add to Slack" link in `multi` mode, remove), Sandbox (controls and debug panel per scope §10, calls `answerQuestion` with entry point `sandbox`).
- `admin/html.ts`: escaping helper; CSP-compatible static script for the sandbox.
- Docs: `docs/architecture/admin.md`.
- Exit: full flow usable from a browser at `http://myhost:8400`; every page escapes content; sandbox output identical to the CLI for the same input.

### S6 — Slack integration

- `slack/manifest.ts` + `scripts/render-manifest.mjs` + `make manifest`: render `manifest.template.json` with `BOT_NAME`, redirect URL (multi mode), the scopes and events of §3.2, Messages tab enabled, Socket Mode enabled.
- `slack/app.ts`: Bolt `App` with `SocketModeReceiver({appToken})`, custom `authorize` → installation store (encrypted bot tokens); `single` mode seeds the store from `SLACK_BOT_TOKEN` via `auth.test` at boot; `multi` mode also seeds the home workspace from `SLACK_BOT_TOKEN` when present.
- `slack/install-routes.ts`: `@slack/oauth` `InstallProvider` with `stateSecret`, our installation store, `installPath /slack/install`, `redirectUriPath /slack/oauth_redirect`, success and failure pages; mounted on the admin server; enabled only in `multi` mode; the install page is behind admin auth, the redirect is not (Slack calls it).
- `slack/handlers.ts`: `message.im` (ignore bot/subtypes), `app_mention` (strip mention, thread reply), slash command (`ack()` immediately, then `respond({response_type: 'ephemeral'})`); "help"/empty → usage hint; errors → fixed reply; every path calls `answerQuestion`.
- `slack/user-context.ts`: `users.info` with `include_locale`, cache 1 hour, fallback to owner zone.
- Docs: `docs/architecture/slack.md` (modes, install flow, pitfalls from an earlier internal project), `DEPLOYMENT.md` sections for both modes and the Tailscale command.
- Exit: Socket Mode connected at boot and after a forced restart; handler tests pass with synthetic payloads; live DM and mention answered in the home workspace (via the optional test-driver token of Appendix E, else deferred to the owner's acceptance).

### S7 — Security hardening and threat model

- `docs/architecture/security.md` completed: threat model (assets, actors, entry points, trust boundaries), the fourteen controls of §6 with their tests, residual risks.
- Repository guards under `tests/repo/`: no owner-name literal in `src/`, `docs/` templates or prompts; `src/calcom` contains no HTTP method but GET and no path outside the allowlist; manifest scopes equal the allowlist; no `tools`/`functions` key in any LLM request builder; `.env` ignored; ports consistent with `.env.example`.
- Integration guards: mock Cal.com server recording every path; mock Slack Web API; prompt-injection corpus (EN/FR, 30 prompts) through the real pipeline with live DeepSeek.
- Container checks: image runs as non-root, read-only rootfs, caps dropped, limits applied (`docker inspect` assertions in a live test).
- `make security-check` = secrets scan + `npm audit --audit-level=high` + the repo guards; wired into `make check` and `make build`.
- Log review: a test asserts no question text appears in captured logs for a sandbox run.
- Exit: every control of §6 has a passing automated check or a documented manual evidence entry.

### S8 — Documentation, deployment on this machine, fresh-clone verification, closeout

- Write and reconcile every document of scope §22: `README.md` (table of contents, architecture at a glance, project layout, prerequisites, setup, make commands), `DEPLOYMENT.md` (single and multi, Slack app from manifest, env file, Tailscale Serve, upgrades, backups, troubleshooting including an earlier internal project's two Slack pitfalls), `docs/user-guide.md` and `docs/guide-utilisateur.md` (how to ask, examples, what it will not do, timezone note), `docs/development/{testing,conventions,release}.md`, `docs/README.md` index, `CLAUDE.md` final, `STATUS.md` entry.
- Fresh-clone verification: clone into a scratch directory, follow `DEPLOYMENT.md` literally in `single` mode with throwaway env, build and run tests; fix any gap in the docs.
- Deploy on this machine: `make build`, `make up`, health green on both addresses, Socket Mode connected, admin reachable, sandbox answers.
- Tag `v0.1.0`, update `STATUS.md` with commit hashes.
- Exit: scope §16 "done when" items 1 to 9 each have evidence in `docs/testing/evidence/S8.md`, except the owner-only manual items listed in the testing plan §8.

## 10. Review rounds (after T8)

Each round is executed by a fresh, independent reviewer context (a new subagent with no access to the previous round's notes until it has written its own), sequentially, and ends with a fix pass and a full `make check` plus the live suites.

| Round | Focus | Output |
| --- | --- | --- |
| R1 | Correctness: availability math, timezone edge cases (DST changes, midnight, week boundaries), date phrases in EN/FR, formatting, fixed replies, error paths | `docs/reviews/R1.md`: findings, severity, fix commits |
| R2 | Integration: Slack handlers and modes, OAuth flow, installation store, admin pages, sandbox parity, Docker and compose, Makefile, restart and boot behaviour | `docs/reviews/R2.md` |
| R3 | Documentation and operability: every statement in every document checked against the code and the running container; user guides tried as a newcomer; `DEPLOYMENT.md` followed literally | `docs/reviews/R3.md` |
| R4 | Security: threat model walk-through, §6 controls one by one, OWASP-style checklist for the admin (auth, session, CSRF, XSS, injection, headers), secrets handling, container hardening, dependency audit, injection corpus rerun, Slack trust boundaries, log inspection | `docs/reviews/R4.md`, tag `v1.0.0` when clean |

A finding of severity high or critical blocks the tag until fixed and re-verified in the same round.

## 11. What the owner provides before the go (nothing else will be asked during execution)

1. **The env file** at `/home/ubuntu/Is-Alex-Available/.env`, mode 600, from the template in Appendix A. The build never prints it.
2. **The Slack app**, created in a workspace where the owner is admin, from the manifest in Appendix B, with: Socket Mode enabled, an app-level token with `connections:write`, the redirect URL set, public distribution activated, the app installed in that workspace. Values to copy into `.env`: client id, client secret, signing secret, app-level token, bot token.
3. **A Cal.com API key** (Settings → Developer → API keys) into `.env`.
4. **A DeepSeek API key** into `.env`.
5. **The Tailscale Serve command** of Appendix D, run once, any time before the go (it returns 502 until the app is up, which is fine).
6. **The free/busy test events** of Appendix C on one calendar that is toggled on in Cal.com, or a note saying which date and calendar were used instead.
7. **Optional, recommended:** the test-driver user token of Appendix E, so the live Slack DM and mention tests run without the owner. Without it, two live checks become a two-minute owner acceptance after the build (testing plan §8).
8. **Confirmation** that `OWNER_NAME=Alex`, aliases, and `BOT_NAME=alex-calendar-agent` are what the Slack app was created with.

## 12. Cross-cutting rules for the autonomous run

- Commit after every step and every testing step; messages `S<n>: …`, `T<n>: …`, `R<n>: …`, `docs: …`, `fix: …`; the trailer lines from the session's attribution rules. Never commit `.env`, `data/`, or evidence containing secrets.
- Consult the documentation MCP server (`cal-com`, `slack`) and DeepSeek's official docs whenever an API detail is uncertain; record the consultation in the step's evidence file.
- Never touch anything outside `/home/ubuntu/Is-Alex-Available`; never run Tailscale or ufw commands; never print secrets.
- If blocked on something only the owner can resolve, write `STATUS.md` with a `BLOCKED` entry stating exactly what is needed, finish every independent step, and stop.
- `make check` must be green before every commit that ends a step.
- Keep `STATUS.md` current at the end of every step (what is live, what is next).

## 13. Risks and open concerns

| Risk | Mitigation |
| --- | --- |
| DeepSeek JSON mode returns empty content occasionally | One retry, then clarification reply; counted in the query log |
| Cal.com API key not available on the current plan | `make calcom-check` is the first live action of S3; if it fails, `BLOCKED` entry with the exact error |
| Slack admin approval blocks installs in some workspaces | Documented; the app works in the others |
| Tailscale IP not yet up when Docker starts at boot | `restart: unless-stopped` retries; T8 verifies a reboot-order simulation by restarting the container with the interface present |
| Google free/busy semantics differ from expectation | T3 matrix documents the real behaviour; fix is on Google's side, user guide updated |
| Bolt/`@slack/oauth` API drift at build time | Pin versions; verify type definitions during S6; the documentation MCP server docs are the reference |

## 14. Decision log

- D14 (2026-10-09): Cal.com and DeepSeek keys are seeded from the env file into encrypted settings at first boot so the autonomous run has no manual admin step; the admin remains the place to rotate them.
- D15: OAuth install routes are served by our Fastify server through `@slack/oauth`, not by Bolt's built-in installer, so there is one HTTP port and one Tailscale Serve mapping.
- D16: `multi` mode seeds the home workspace from `SLACK_BOT_TOKEN` so the home workspace needs no OAuth round trip.
- D17: Luxon for timezone math; `Intl` for localized names; no custom DST logic.
- D18: Fastify over Express for parity with an earlier internal project's hardening plugins.
- D19 (2026-10-09, during S4): thinking is off for the phrasing call only; the parse call keeps effort `low`. Measured: same verified output, 3–5 s and 450–750 reasoning tokens saved per answer. Reasoning tokens count inside `max_tokens`, so caps were raised (1,500 parse, 600 phrase) with one doubled retry on empty content.
- D20 (during S4): the verifier requires the zone label and every qualifier (duration, excluded weekdays, part of day) in the phrased reply, after a live run showed the model dropping "windows of at least 1 hour".
- D21 (during S2): `node:sqlite` instead of better-sqlite3: no native build on alpine or on the host, same SQL; `backup()` API for snapshots.

---

## Appendix A — `.env` template (create at `/home/ubuntu/Is-Alex-Available/.env`, `chmod 600`)

```
# ---- identity ----------------------------------------------------------------
OWNER_NAME=Alex
OWNER_ALIASES=Alexandre,Alexandre Dupont
# BOT_NAME=alex-calendar-agent        # optional, derived from OWNER_NAME when absent

# ---- install mode ------------------------------------------------------------
INSTALL_MODE=multi                    # single | multi

# ---- network -----------------------------------------------------------------
APP_PORT=8400
APP_BIND_ADDRESSES=127.0.0.1,100.64.0.1
PUBLIC_BASE_URL=https://myhost.tailnet-example.ts.net:8445   # multi mode only

# ---- slack (from the app created with Appendix B) ----------------------------
SLACK_APP_TOKEN=xapp-...              # App-Level Tokens, scope connections:write
SLACK_SIGNING_SECRET=...              # Basic Information
SLACK_BOT_TOKEN=xoxb-...              # OAuth & Permissions, after Install to Workspace
SLACK_CLIENT_ID=...                   # multi mode only
SLACK_CLIENT_SECRET=...               # multi mode only
SLACK_STATE_SECRET=                   # multi mode only; generate: openssl rand -hex 32

# ---- admin and encryption ----------------------------------------------------
ADMIN_PASSWORD=                       # choose a long one; never shared
MASTER_KEY=                           # generate: openssl rand -base64 32

# ---- provider keys (seeded into encrypted settings at first boot) -------------
CALCOM_API_KEY=cal_live_...
DEEPSEEK_API_KEY=sk-...

# ---- misc --------------------------------------------------------------------
LOG_LEVEL=info
```

## Appendix B — Slack app manifest (paste at api.slack.com/apps → Create New App → From a manifest, in a workspace where you are admin)

```json
{
  "_metadata": { "major_version": 1, "minor_version": 1 },
  "display_information": {
    "name": "alex-calendar-agent",
    "description": "Ask when Alex is available. Free/busy only, never books anything.",
    "background_color": "#1f2937"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": { "display_name": "alex-calendar-agent", "always_online": true },
    "slash_commands": [
      {
        "command": "/alex-calendar-agent",
        "description": "Ask when Alex is available",
        "usage_hint": "is Alex free Monday at 4pm?",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "redirect_urls": ["https://myhost.tailnet-example.ts.net:8445/slack/oauth_redirect"],
    "scopes": {
      "bot": ["app_mentions:read", "chat:write", "commands", "im:history", "im:read", "im:write", "users:read"]
    }
  },
  "settings": {
    "event_subscriptions": { "bot_events": ["app_mention", "message.im"] },
    "interactivity": { "is_enabled": false },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

After creation: Basic Information → App-Level Tokens → Generate (scope `connections:write`) → `SLACK_APP_TOKEN`; Basic Information → App Credentials → `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`; OAuth & Permissions → Install to Workspace → `SLACK_BOT_TOKEN`; Manage Distribution → Activate Public Distribution. Do installs from a desktop browser (an earlier internal project's mobile double-callback pitfall).

## Appendix C — Free/busy test matrix (create on one calendar toggled ON in Cal.com; default date Wednesday 2026-10-28; tell me if you use another weekday within the next 4 weeks)

| Time (your schedule zone) | Event | Expected by the bot |
| --- | --- | --- |
| 09:00–09:30 | Invitation sent from another of your accounts, **accepted** | busy |
| 10:00–10:30 | Invitation, answered **Maybe** | busy |
| 11:00–11:30 | Invitation, **not answered** | busy |
| 13:00–13:30 | Invitation, **declined** | free (to be confirmed) |
| 14:00–14:30 | Your own event, "Show me as: **Available**" | free |
| 15:00–15:30 | Your own normal event | busy |
| all day, same date | All-day event left at Google's default | day NOT blocked |
| all day, next day 2026-10-29 | All-day event set to **Busy** (optional) | whole day busy |

Keep the rest of that day free of real meetings. The events can be deleted after T3 reports.

## Appendix D — Tailscale Serve (run once by the owner, any time before the go)

```
tailscale serve --bg --https=8445 http://127.0.0.1:8400
```

Check with `tailscale serve status`; ports 443, 8443 and 8444 stay untouched. Needed in `multi` mode only.

## Appendix E — Optional test-driver user token (lets the live Slack tests run without you)

Create a second, throwaway app "calendar-agent-test-driver" in the same home workspace with **user** scope `chat:write` only, install it, and put its user token in `.env` as `SLACK_TEST_USER_TOKEN=xoxp-...`. The tests use it to post a DM to the bot and an @mention in a test channel of your choice (`SLACK_TEST_CHANNEL_ID=C…`, a channel where the bot is a member). The slash command cannot be triggered by API; its live check stays a 10-second manual step for you (testing plan §8). Remove the app afterwards.
