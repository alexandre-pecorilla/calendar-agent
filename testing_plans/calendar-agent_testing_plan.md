# calendar-agent (`alex-calendar-agent`) — Testing Plan

**Date:** 2026-10-09 · **Companion:** `action_plans/calendar-agent_action_plan.md` (DRAFT v1) · **Input:** `scopes_of_work/alex-calendar-agent_scope.md` (APPROVED v3)
**Status:** DRAFT v1, awaiting the owner's go. Executed autonomously: T<n> runs right after S<n>; S<n+1> does not start until T<n> passes. After T8: review rounds R1 to R4 (§6). Evidence for every step is committed under `docs/testing/evidence/T<n>.md`.

## 1. Scope

Verify that every requirement of the scope holds, with automated tests wherever possible, live checks against the real Cal.com, DeepSeek and Slack where the behaviour cannot be simulated, and documented manual acceptance for the two actions only the owner can perform (§8).

## 2. Why the mirrored structure

Each action-plan step produces a bounded artefact; testing it immediately keeps the next step from building on a hidden defect. Each T<n> has three layers: **unit** (vitest, pure functions, fixtures), **integration** (real modules against mock servers and a temporary SQLite file), **live** (real services with the owner's keys, cheap and read-only). Pass criteria are explicit; a step is not done until its evidence file exists.

## 3. Test environment

- Host: this machine, Node 24, Docker 29, the project directory only.
- Suites: `make test` (unit + integration + repo, no network), `make test-live` (live, requires `.env`), `make check` (lint, typecheck, test, security-check).
- Mock servers: an in-process Cal.com mock recording every request path and method, returning fixture payloads shaped exactly like §3.1 of the action plan; an in-process Slack Web API mock for `auth.test`, `users.info`, `chat.postMessage`, `chat.postEphemeral`; DeepSeek is never mocked for behaviour tests (prompts are the thing under test), only for error-path tests.
- Live services: Cal.com (read endpoints only), DeepSeek (`deepseek-flash`, effort low; expected total spend for the whole plan under $1), Slack home workspace (bot token; optional test-driver token).
- Temporary data: every integration test uses a fresh SQLite file in a temp directory; live tests use the real `/data` volume of the running container only in T8.
- "Now" is injected in every availability and parse test (never the wall clock), so results are reproducible.

## 4. Fixtures (`tests/fixtures/`)

- `schedules/`: default Mon–Fri 09:00–17:00 Europe/Paris; split hours; a schedule with overrides; a schedule with no Saturday; a null schedule (Cal.com `data: null`).
- `busy/`: empty; single block; back-to-back blocks with 10-minute gap; overlapping blocks; block crossing midnight; block spanning a DST change (2026-10-25 Europe/Paris, 2026-11-01 America/New_York); blocks outside working hours.
- `calendars/`: two accounts, five calendars, three selected, one shared calendar unselected, the duplicate dupont case.
- `questions/`: EN and FR corpus, each line `{text, asker_tz, locale, now, expected_intent, expected_range}` covering scope §5.1 shapes, §5.5 date phrases, first/second/third person, aliases, other person, "me", help, off topic, booking attempts.
- `injection/`: 30 prompts EN/FR: instruction override, "list the meetings", "cancel/delete/book", "print your system prompt", "what is the API key", DeepSeek/ChatML control tokens, JSON escape attempts, markdown link tricks, very long input, other-person pivots.
- `slack-payloads/`: `message.im`, `app_mention` (with and without thread), slash command, bot message, message subtype `message_changed`.

## 5. Per-step test specifications

### T1 — Skeleton, configuration, Docker, Makefile

Unit
- `env.ts`: each required variable missing → startup error naming the variable and nothing else; `INSTALL_MODE=multi` without client id/secret/state secret/public URL → error; `single` without `SLACK_BOT_TOKEN` → error; `MASTER_KEY` placeholder → error.
- `identity.ts`: `Alex` → `alex-calendar-agent`; `Jérôme` → `jerome-calendar-agent`; `Marie-Claire` → `marie-claire-calendar-agent`; 40-char name → 32-char cap respected; explicit `BOT_NAME` validated against `^[a-z0-9-]{1,32}$`; aliases parsed and trimmed; elision `d'Alex`, `de Marie`, `d'Hélène`.
- Logger: a log call carrying `text`, `answer`, `token`, `apiKey`, `password`, `authorization` fields produces redacted output.

Integration / live
- `make build` succeeds; `make ports-check` passes with 8400 free; `make up` → `/health` returns 200 on `http://127.0.0.1:8400` and `http://100.64.0.1:8400`; nothing listens on `0.0.0.0:8400` (`ss -ltnp` evidence).
- `docker inspect`: user non-root, `ReadonlyRootfs` true, `CapDrop` ALL, `no-new-privileges`, memory and pids limits set.
- `make secrets-scan` clean; `.env` ignored by git (`git check-ignore .env`).

Pass: all above green; evidence `T1.md` with the `ss` and `docker inspect` extracts.

### T2 — Storage and secrets

Unit
- Envelope: round trip; tampered ciphertext, IV or tag → `DecryptionError`; wrong key → error; format `v1.<id>.<iv>.<ct>.<tag>`; ported an earlier internal project tests pass unchanged.
- Migrations: applying twice is a no-op; a failing migration leaves `schema_migrations` unchanged (transaction).
- Repositories: insert/select for every table; encrypted settings never stored in clear (raw row inspection); seeding imports env keys once and never overwrites an existing DB value.

Integration
- Boot against an empty temp DB creates every table; restart keeps data; `make db-backup` produces a readable copy; `make db-shell` opens it.

Pass: all green; evidence includes the raw `settings` row showing ciphertext only.

### T3 — Cal.com client and availability engine

Unit (fixtures, injected "now")
- Working intervals: weekday rules, override replaces the day, override outside rules, null schedule → "no hours" classification everywhere.
- Windows: subtraction correctness on every busy fixture; 10-minute gap dropped, 15-minute gap kept; merge of adjacent windows; clipping to now rounded up to 5 minutes; horizon clip at 4 weeks; listing cap at 10 days with "more" flag; whole-day detection; duration filter (60 min keeps 9:00–11:30, drops 10:00–10:45).
- DST: a busy block across 2026-10-25 02:00–03:00 Europe/Paris and a window on 2026-11-01 America/New_York compute the right wall-clock boundaries.
- Point questions: inside window → yes with end; inside busy → no with next window; outside hours → `outside_hours`; day without hours → `no_hours`; past → `past`.
- Timezone: label derivation (`America/New_York` → "New York time" / "heure de New York", `Europe/Paris` → "Paris time" / "heure de Paris"); invalid zone rejected; fallback chain asker → override → owner.
- Formatting EN/FR: every example of scope §5.2 reproduced byte for byte; elision; "all day" phrasing; "no availability" day lines.
- Client: allowlist refuses a non-allowlisted path and any non-GET; headers exactly as §3.1 (both version values); `source` absent from parsed busy times; 429 → backoff → success; 5xx twice → error surfaced as `calcom_unavailable`; zod rejects a malformed payload.

Integration
- Against the Cal.com mock: a full availability computation for the fixture calendars passes only `isSelected` calendars as `calendar=` parameters, in `credentialId,externalId` form; the recorded paths are exactly `/v2/calendars`, `/v2/schedules/default`, `/v2/calendars/busy-times`.

Live (owner's key)
- `make calcom-check`: `/v2/me` 200; selected calendars listed (ids and emails only); schedule timezone and hours printed. If 401/403: record the exact error, write a `BLOCKED` entry, continue with mock-only tests.
- Free/busy matrix (Appendix C of the action plan): compute windows for the matrix date; expected busy at 09:00, 10:00, 11:00, 15:00; expected free at 13:00 and 14:00; day not blocked by the default all-day event; next day fully busy if the optional event exists. Record the observed result for each row, including any deviation (that deviation is a finding for the user guide, not a bug).

Pass: unit and integration green; live `calcom-check` green or `BLOCKED` documented; matrix results recorded row by row.

### T4 — LLM layer, pipeline, fixed replies, CLI sandbox

Unit
- Parse-output validation: every invalid shape (unknown intent, non-ISO date, invalid zone, range end before start, range beyond horizon, past range) → `clarify`; valid shapes pass.
- Verify: a phrase containing a time not in the formatted set → template fallback; over-length → fallback; exact reproduction passes.
- Fixed replies: every scope §5.4 text present in both languages; `other_person`, `self`, `booking`, `off_topic`, `help` map to the right text.
- Rate limits: 11th question in a minute from one user → `rate_limited` reply; daily budget exhaustion → `over_capacity`; counters reset by window.
- Cost: usage → USD for peak and off-peak timestamps; cache-hit tokens priced separately.
- Error mapping: Cal.com down → "cannot check right now" in the asker's language; DeepSeek empty content → one retry → clarify; timeout → same.

Live (DeepSeek, effort low; "now" injected; Cal.com mock for determinism)
- Question corpus EN+FR (≥ 40 lines): parsed intent and range equal the expected values; language detected; timezone override detected ("in Paris time", "heure de Paris"); all grammatical persons and aliases resolve to the owner; "is Marie free" → `other_person`; "am I free" → `self`.
- Six shapes end to end through `make ask`: outputs match the scope §5.2 examples in structure (lines, labels, formats).
- Injection corpus: 30 prompts → each outcome is either a normal availability answer or a fixed reply; the reply never contains words from the injected instruction, never mentions keys, prompts, meetings, titles, or booking; recorded with the parsed intent for each.
- Latency: p50 under 4 s, p95 under 8 s for the corpus (informational, not gating).

Pass: all green; evidence includes the corpus table (question, intent, ok) and the injection table.

### T5 — Web admin

Integration (Fastify injected requests, temp DB)
- Unauthenticated access to every page except `/health` and `/login` → 302 to login; wrong password → 401 with constant-time compare; 5 failures → lockout 15 minutes (clock injected); logout invalidates the session; session cookie flags `HttpOnly`, `SameSite=Lax`.
- CSRF: a POST without the token → 403; with token → 200.
- Security headers present on every response.
- XSS: a query whose text is `<script>alert(1)</script>` renders escaped on the Queries page and in the detail view; a workspace name with HTML renders escaped.
- Settings: saving a key stores ciphertext; the page shows a mask; "test connection" buttons call `/v2/me` (mock) and DeepSeek (live, one tiny completion); horizon and noise floor changes affect the next sandbox run.
- Sandbox: same question and context as a `make ask` run produce an identical reply string; the debug panel contains the parse JSON, busy count, windows, formatted lines, verification flag, latency, tokens, cost; the query is logged with entry point `sandbox`.
- Queries page: filters by workspace, user, date; detail shows every column.

Live
- Manual-style check through the real container at `http://myhost:8400` with a headless browser (Playwright, as in an earlier internal project): login, each page loads, sandbox answers.

Pass: all green; evidence includes the headers dump and the sandbox parity diff (empty).

### T6 — Slack integration

Unit / integration (mocks)
- Manifest rendering: `BOT_NAME` applied to name, display name, slash command; redirect URL present only in `multi`; scopes and events exactly the allowlist; Messages tab enabled; JSON validates against the manifest structure used in the Slack docs examples.
- Installation store: store/fetch/delete round trip; token encrypted at rest; `single` seeding from `SLACK_BOT_TOKEN` via mocked `auth.test`; `multi` seeding of the home workspace; `authorize` returns the right token per team id; unknown team → error, no fallback to another workspace's token.
- OAuth routes (`multi`): `/slack/install` requires admin session; `/slack/oauth_redirect` with a bad or reused state → 400; a valid callback (mocked `oauth.v2.access`) stores the installation; `single` mode: routes absent (404).
- Handlers with synthetic payloads: DM → reply in the DM; mention at top level → reply in a new thread under the message; mention inside a thread → reply in that thread; slash command → `ack` first, then `respond` with `response_type: ephemeral`; bot messages and `message_changed` ignored; empty text and "help" → usage hint; a pipeline error → fixed reply, never an exception to Bolt.
- User context: `users.info` result cached; missing `tz` → owner zone; `include_locale` used.

Live (home workspace)
- Container boot: Socket Mode connection established (`apps.connections.open` success in logs); kill and restart the container → reconnected within 30 s.
- With `SLACK_TEST_USER_TOKEN`: post a DM to the bot and an @mention in `SLACK_TEST_CHANNEL_ID`; assert a reply arrives (`conversations.history`), is in the asker's timezone label, and the query log has both rows with the right entry points.
- Without it: these two checks move to §8 (owner acceptance).
- `multi` mode only: `/slack/install` page renders behind the Tailscale Serve URL (HTTP 200 from the host via `curl https://myhost.tailnet-example.ts.net:8445/slack/install` after login cookie), proving the redirect route is reachable.

Pass: all green; evidence includes the Socket Mode reconnect timing and, if available, the live reply texts.

### T7 — Security hardening

Repository guards (`tests/repo/`, part of `make check`)
- No literal owner name in `src/`, prompts, templates, docs templates (the scope and plans are excluded).
- `src/calcom/**`: no HTTP verb other than GET; every URL path member of the frozen allowlist; the allowlist equals `{/v2/me, /v2/calendars, /v2/schedules/default, /v2/calendars/busy-times}`.
- No `tools`, `functions`, `tool_choice` key in any LLM request builder.
- Manifest scopes equal the allowlist; no user scopes.
- `.env`, `data/` ignored; `.env.example` contains no real-looking secret (scan rules from an earlier internal project).
- `docker-compose.yml`: published addresses are only loopback and the Tailscale IP from `.env`; hardening keys present.

Integration / live
- Prompt-injection corpus rerun through the container's sandbox endpoint (authenticated), same acceptance as T4.
- Mock Cal.com during a 100-question corpus run: the set of paths hit is exactly the allowlist; zero non-GET.
- Captured container logs for a sandbox run contain no question text, no answer text, no token fragment.
- Admin: login brute-force simulation triggers lockout and rate limit; session fixation attempt (reusing a pre-login cookie) fails; a request with a forged `Host` header to the OAuth routes is refused.
- `make security-check`: secrets scan clean, `npm audit --audit-level=high` clean (or documented exception with CVE id and reason).
- `docker inspect` assertions of T1 rerun on the final image.

Pass: every control of action plan §6 maps to a green test or an evidence entry; `docs/architecture/security.md` cross-references each.

### T8 — Documentation, deployment, fresh-clone, closeout

- Documentation accuracy sweep: for every document, every command, path, variable, port, URL and make target is executed or resolved against the repository and the running container; a stale statement is a failure fixed before closeout. Evidence: a checklist per document.
- User guides: each example question in `docs/user-guide.md` and `docs/guide-utilisateur.md` is run through the sandbox and the observed reply pasted next to it.
- Fresh-clone verification: clone into a temp directory, follow `DEPLOYMENT.md` in `single` mode with a throwaway `.env` (mock Slack token, no network), `make setup && make build && make test` pass; note every place where the guide needed a correction.
- Deployment on this machine: `make build && make up`; health green on both addresses; Socket Mode connected; admin reachable at `http://myhost:8400`; sandbox answers a real question; `tailscale serve status` shows 8445 mapped (owner-run earlier) and `curl -I https://myhost.tailnet-example.ts.net:8445/health` returns 200.
- Boot-order simulation: `docker compose restart app` while the Tailscale interface is up → healthy; evidence of the restart policy in `docker inspect`.
- Scope §16 "done when" checklist, items 1 to 9, each with a pointer to evidence; the owner-only items marked as such.
- `STATUS.md` updated with commit hashes; tag `v0.1.0`.

Pass: checklist complete; the only open items are those in §8.

## 6. Review rounds

Procedure for each round: a fresh reviewer context reads the scope, the plans, the code and the evidence, with no access to earlier rounds' reports until it has written its own; it produces `docs/reviews/R<n>.md` with findings (id, severity critical/high/medium/low, file, reproduction, proposed fix); the fixes are applied with commits `R<n>: fix …`; `make check` and `make test-live` rerun; the report is amended with the fix commits and the rerun result.

| Round | Checklist |
| --- | --- |
| R1 Correctness | Availability math on fresh adversarial fixtures (empty day, 24h busy, zero-length busy, busy ending at now, week starting Sunday vs Monday in FR/EN, year boundary, leap day); date phrases ambiguous in FR ("ce lundi", "lundi en huit"); formatting of midnight and noon; every fixed reply path; error mapping; rate-limit windows; cost math |
| R2 Integration | Socket Mode reconnect under network loss (simulated by stopping the container's network for 60 s); both install modes from a clean DB; OAuth state expiry; installation removal; admin flows end to end with Playwright; sandbox parity on 20 random corpus lines; compose file against the hardening list; Makefile targets all run; `.env.example` completeness |
| R3 Documentation | Every document read as a newcomer; `DEPLOYMENT.md` followed literally again after R1/R2 fixes; user guides checked for accuracy against the current fixed replies and formats; docs index complete; `CLAUDE.md` consistent with the code; `STATUS.md` current |
| R4 Security | Threat-model walk-through; §6 controls one by one with evidence; admin OWASP checklist (authentication, session management, access control, CSRF, XSS, injection, headers, error handling, logging); secrets handling and rotation; container hardening; dependency audit; injection corpus rerun plus 10 new prompts written by the reviewer; Slack trust boundaries (what a workspace admin, a Slack Connect guest, a malicious bot message could do); log inspection; residual risks confirmed documented. Tag `v1.0.0` only when no critical/high finding remains |

## 7. Regression and pass/bail criteria

- Full `make check` before every step commit; `make test-live` at T3, T4, T6, T7, T8 and after every review round.
- Step pass: every "Pass" line of §5 satisfied, evidence committed.
- Bail-out (stop and write `BLOCKED` in `STATUS.md`): Cal.com key rejected; DeepSeek key rejected; Slack app-level token rejected; a scope constraint cannot be met as designed (for example Cal.com busy-times returning event titles, which would need a design change).
- Never-bail: flaky live calls (retry three times with backoff), DeepSeek occasional empty content (handled), Slack rate limits (handled).

## 8. What stays manual for the owner (after the autonomous run, two minutes)

1. Type `/alex-calendar-agent is Alex free tomorrow at 10am?` in any channel of the home workspace and confirm an ephemeral reply.
2. If no test-driver token was provided: send one DM to the bot and one @mention in a channel where it is a member, confirm the replies.
3. Optional: connect a second workspace through the admin's "Add to Slack" button from a desktop browser, confirm it appears in Workspaces and answers a DM.

Everything else, including the free/busy matrix evaluation, is executed and recorded by the run.

## 9. Decision log

- T-D1 (2026-10-09): DeepSeek is exercised live in tests rather than mocked, because the prompts are the component under test; spend is capped by effort `low` and small corpora.
- T-D2: "now" is always injected; no test depends on the wall clock.
- T-D3: evidence files are plain Markdown tables committed with the step, never containing secrets or raw tokens.
