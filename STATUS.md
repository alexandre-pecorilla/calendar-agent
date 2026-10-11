# STATUS

## 2026-10-09 — S8 documentation, deployment, fresh clone; build complete, tag v0.1.0 | Commit: `992e51f`

- Scope APPROVED v3, action plan and testing plan DRAFT v1 accepted by the owner.
- Credentials verified live before the go: Cal.com (`owner-username`, schedule America/New_York 07:00–19:00 daily, 6 selected calendars), DeepSeek, Slack bot token (workspace Acme) and app-level token.
- Tailscale Serve 8445 → 127.0.0.1:8400 mapped by the owner.
- Free/busy matrix events created by the owner on owner@example.com for 2026-10-10 (and an all-day busy event on 2026-10-11).
- S1: repo, config (zod, identity derivation), logger with redaction, health server, Dockerfile, compose (hardened, two publish addresses), Makefile, guard scripts, docs skeleton. T1: 17 unit tests, container healthy on both addresses, hardening verified (`docs/testing/evidence/T1.md`).
- S2: `node:sqlite` database in the volume, numbered migrations, AES-256-GCM envelope (from an earlier internal project) for provider keys and Slack tokens, repositories (settings, queries, installations, sessions, Slack user cache), env seeding at first boot, `make db-backup`. T2: 32 tests, container verified (`docs/testing/evidence/T2.md`).
- S3: GET-only allowlisted Cal.com client with cache, schedule → working intervals, free-window computation (noise floor, now rounding, duration, horizon, caps), point verdicts, timezone resolution and labels, EN/FR formatting and deterministic rendering, `make calcom-check`. T3: 59 tests; live matrix on 2026-10-10 confirms Google semantics (accepted/maybe/unanswered busy, declined/free free, all-day default not blocking, all-day busy blocking); two fixes (zone mixing, Cal.com dateTo clipping). Evidence `docs/testing/evidence/T3.md`.
- S4: DeepSeek client (thinking low for parsing, off for phrasing, token caps, retry, cost), parse prompt + schema, phrase prompt + verifier (times, bullets, required qualifiers), fixed replies EN/FR, abuse limits, the single `AnswerPipeline`, `make ask`, `make deepseek-check`. T4: 76 hermetic tests; live corpus 40/40, injections 30/30, $0.0125 per 40 questions, p50 2.5 s. Evidence `docs/testing/evidence/T4.md`.
- S5: Fastify admin on port 8400: scrypt password, hashed sessions, lockout, CSRF, security headers; pages Queries, Settings (encrypted keys, test buttons), Workspaces, Sandbox (same pipeline, debug panel). T5: 86 tests; live on http://myhost:8400 and https://myhost.tailnet-example.ts.net:8445. Evidence `docs/testing/evidence/T5.md`.
- S6: Bolt Socket Mode app with per-workspace `authorize` from the encrypted store, env-token seeding via auth.test, DM / mention / slash handlers as testable functions, users.info context cache, `@slack/oauth` installer on the admin server (multi mode), manifest renderer (`make manifest`), docs/architecture/slack.md and DEPLOYMENT.md. T6: 12 hermetic tests; live: connected, Acme seeded, reconnect 3 s, HTTPS install redirect correct. Evidence `docs/testing/evidence/T6.md`.
- S7: threat model and 15-control map in docs/architecture/security.md; repository guards (no owner literal, no LLM tools, Cal.com allowlist, Slack scopes, deployment hardening); forged-Host and 100-question path-set checks; live container inspection, log-content canary and container-sandbox injections. Evidence `docs/testing/evidence/T7.md`.
- S8: README, DEPLOYMENT.md, EN/FR user guides, architecture and development docs, `make docs-check` in the gate; fresh clone verified in single mode; live instance rebuilt (Socket Mode connected, Acme workspace, all three URLs). T8 evidence `docs/testing/evidence/T8.md`.
- Live now: http://myhost:8400 (admin), https://myhost.tailnet-example.ts.net:8445 (same, HTTPS, Slack installer), Slack app `alex-calendar-agent` in Acme.
- Owner acceptance pending (two minutes in Slack): one DM, one @mention in a channel where the bot is a member, one `/alex-calendar-agent` command.
- Next: review rounds R1 (correctness), R2 (integration), R3 (documentation), R4 (security).

## 2026-10-09 — R1 correctness review closed | Commits: `2f19b0b` (fixes), `8eb3adc` (report)

- Eleven findings (2 high, 4 medium, 5 low), all fixed: minute-precision past check, reply verifier rewritten (ordered time sequence, dates, bullets, polarity, required qualifiers), whole-day detection across zones, `free_short` verdict, zone abbreviations mapped and bare city names refused, afternoon from noon, French labels, limits counted once. Live rerun: corpus 40/40, injections 30/30. Report `docs/reviews/R1.md`.

## 2026-10-09 — R2 integration review closed | Commits: `a28e815` (report), `94da9a0` (fixes), `4786530` (report amended)

- Thirteen findings (1 high, 5 medium, 7 low), all fixed: install flow bound to the HTTPS origin of `PUBLIC_BASE_URL` with real Slack error codes on the failure page; `.env` parsed the same way by Compose, Node, scripts and Makefile (comments on their own line, placeholders refused later in R3); Socket Mode status cleared on reconnect; `make manifest` from the identity variables only; `make db-restore`; env-seeded workspace without Remove button; early signal handlers; sandbox "no zone" option; logout with CSRF; limiter page; compose environment allowlist. Gate: 126 hermetic tests. Report `docs/reviews/R2.md`.

## 2026-10-09 — R3 documentation and operability review closed | Commits: `3494f97` (report), `ecb629f` (fixes)

- Twenty-five findings (1 high, 7 medium, 17 low), all fixed: a master-key change no longer leaves the instance unhealthy (unreadable rows reported and replaceable, documented rotation); template placeholders refused and never seeded; `make ask`, `calcom-check` and `deepseek-check` run inside the container with the instance's keys; Makefile chains as prerequisites (`make -n` is a real dry run); French help without a masculine pronoun; signing secret optional; documentation corrected throughout and a "deviations from the plans" list added. Gate: 133 hermetic tests. Report `docs/reviews/R3.md`.
- Next: R4 security review, then tag `v1.0.0` if it reports nothing critical or high; owner acceptance in Slack.

## 2026-10-09 — R4 security review closed, version 1.0.0 | Commits: `a3178eb` (report), `46233bc` (fixes); tag `v1.0.0`

- Nine findings (0 critical, 1 high, 2 medium, 6 low), all fixed: progressive login delay instead of a global lockout (nobody can lock the owner out); honest client provenance in the login log and a socket-keyed limiter; Slack library debug output discarded at every log level; verifier refuses Slack markup and every link spelling and requires the owner's name; stricter repository guards; backups mode 600; sessions with idle timeout, ended on password change, "Log out everywhere"; HSTS over HTTPS, trimmed anonymous `/health`, digest-pinned base image. Live suites rerun after the rebuild: container 3/3, LLM 2/2 (injections clean). Gate: 140 hermetic tests. Report `docs/reviews/R4.md`.
- Every hard limit of the scope verified by four independent rounds: free/busy only, read only, no booking, no event details, LLM without tools and with user text in the parse call only, verified replies, encrypted secrets, hardened container, tailnet-only admin.
- Live: http://myhost:8400 (admin), https://myhost.tailnet-example.ts.net:8445 (same over HTTPS; the Add-to-Slack flow must start here), Slack app `alex-calendar-agent` in Acme. Owner acceptance: DM and slash command confirmed by the owner; the channel mention was being tried (the bot must be invited to the channel first).
- Next: the owner installs the other workspaces from the Workspaces page over HTTPS; nothing else is pending on the build.

