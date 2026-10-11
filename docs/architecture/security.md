# Security

The bot is reachable by everyone in every Slack workspace it is installed in,
so it is treated as an internet-facing input surface. This document is the
threat model and the list of controls, each with the test that proves it.

## Assets

1. The owner's calendar content (titles, attendees, locations): **never in
   the system**. The only calendar data is busy intervals and the schedule.
2. The owner's Cal.com API key: full-privilege on the owner's account.
3. The DeepSeek API key and the Slack tokens (app-level, bot per workspace).
4. The admin password and sessions.
5. The query log: who asked what, and the answers.
6. The host machine and the other services on it.

## Actors and entry points

- Any member or guest of an installed workspace, including Slack Connect
  participants: DM, @mention, slash command (text only).
- Anyone who can reach the admin port: tailnet members only (loopback and the
  Tailscale IP; nothing on a public interface).
- Slack itself (events over the authenticated WebSocket, OAuth callback).
- The providers' responses (Cal.com, DeepSeek) as untrusted data.
- A reader of a database backup.

## Trust boundaries

Slack text → sanitiser → **call 1 only** → schema → code → Cal.com (GET only)
→ code → renderer → **call 2** (code-generated input only) → verifier → Slack.
The model is never a boundary that protects anything: there is nothing in its
context to leak and nothing it can call.

## Controls

| # | Control | Where | Proof |
| --- | --- | --- | --- |
| 1 | The model has no tools; it returns JSON or text only | `src/llm/deepseek.ts` | `tests/repo/no-llm-tools.test.ts` |
| 2 | Cal.com surface: four GET functions, frozen path allowlist, one fetch call | `src/calcom/client.ts` | `tests/repo/calcom-allowlist.test.ts`, `tests/integration/calcom-client.test.ts` (recorded paths) |
| 3 | Only call 1 sees the asker's text; its output is schema-validated; call 2 gets the deterministic draft | `src/llm/parse.ts`, `phrase.ts`, `pipeline/answer.ts` | `tests/unit/llm-and-pipeline.test.ts`, `tests/integration/pipeline.test.ts` |
| 4 | Replies verified: only rendered time tokens, bullet lines verbatim, zone label and qualifiers required, length cap, no links; else the draft | `src/llm/verify.ts` | unit tests; live corpus (T4) |
| 5 | Input hygiene: markup stripped, 500-char cap, control tokens neutralised, bots/edits ignored | `src/security/*`, `src/slack/handlers.ts` | unit tests; handler tests |
| 6 | Abuse limits: per user, per workspace, global, daily budget | `src/pipeline/rate-limit.ts` | `tests/integration/pipeline.test.ts` |
| 7 | Secrets: `.env` mode 600 and ignored; keys and tokens AES-256-GCM at rest with AAD; `Secret` wrapper; masked in the admin; never returned by a route; committed-secret scan | `src/crypto/*`, `src/db/repos/*`, `scripts/scan-secrets.mjs` | `tests/unit/envelope.test.ts`, `tests/integration/db.test.ts`, `make secrets-scan` |
| 8 | Admin: scrypt password, hashed opaque sessions (30-day TTL, 7-day idle timeout, ended on password change), DB-backed progressive login delay (global, no client key), login rate limit keyed on the connecting socket, CSRF double-submit, CSP without inline scripts, frame denial, nosniff, no-referrer, no-store, HSTS over HTTPS, output escaping | `src/admin/*` | `tests/integration/admin.test.ts`, `tests/unit/lockout.test.ts` |
| 9 | Network: published on loopback and the Tailscale IP only; Socket Mode outbound; OAuth redirect over tailnet HTTPS; state signed with the state secret, time-limited and bound to a browser cookie on the HTTPS origin | compose, `src/slack/*` | `tests/repo/deployment-hardening.test.ts`, `tests/live/container.test.ts`, `tests/integration/slack.test.ts` |
| 10 | Container: non-root, read-only rootfs, tmpfs /tmp, all capabilities dropped, no-new-privileges, memory and pid limits, log rotation | `Dockerfile`, `docker-compose.yml` | `tests/live/container.test.ts` |
| 11 | Logs carry no content: redaction of text/answer/secret keys; the Slack libraries' debug output (full event payloads) is discarded at every `LOG_LEVEL`; content only in SQLite | `src/logging/logger.ts`, `src/slack/app.ts` (`boltLogger`) | `tests/unit/logger.test.ts`, `tests/integration/pipeline.test.ts`, `tests/integration/slack.test.ts`, `tests/live/container.test.ts` |
| 12 | Dependencies: pinned lockfile, `npm audit --audit-level=high` gate, minimal set | `package-lock.json`, Makefile | `make security-check` |
| 13 | Injection corpus through the real pipeline: outcome is a fixed reply or a plain availability answer, no forbidden words | `tests/fixtures/questions.ts` | `tests/live/llm.test.ts` (T4, T7) |
| 14 | No owner literal in the product; identity from configuration; the owner's real terms (local, gitignored list) absent from every published file and commit message | `src/config/*`, `scripts/check-private-words.mjs` | `tests/repo/no-owner-literal.test.ts`, `make private-words-check` (also the pre-push hook) |
| 15 | Slack least privilege: seven bot scopes, two events, no user scopes; per-workspace tokens never cross | `src/slack/scopes.ts`, `authorize.ts` | `tests/repo/slack-scopes.test.ts`, `tests/integration/slack.test.ts` |

## What an attacker can and cannot do

- **Through Slack text**: obtain free/busy answers (the product), spend a
  bounded number of model calls (limits), get a fixed refusal. They cannot
  reach Cal.com writes (no path exists), read titles (none exist), extract
  keys or prompts (not in the model's context), or post links or arbitrary
  text through the bot (verifier).
- **Through the OAuth callback**: nothing without a valid signed state and a
  code Slack issued for our client id; a forged callback is a 400 page.
- **On the tailnet**: the admin asks for the password; after each failure the
  next attempt is delayed (1 s, doubling to a 60 s cap, measured from the last
  failure), which caps guessing at about one try a minute and never refuses the
  right password for more than a minute, so nobody can lock the owner out
  (R4-1); a stolen cookie is HttpOnly, ends after 7 idle days or 30 days, and
  dies when `ADMIN_PASSWORD` changes or the owner clicks "Log out everywhere".
- **With a copied database**: ciphertext only for every secret; the query log
  is readable (who asked what), which is why backups stay on the owner's
  machines.

## Residual risks, named

- No egress firewall inside the container: a compromised dependency could
  call out. Mitigation: pinned lockfile, audit gate, minimal dependencies.
- A compromised `MASTER_KEY` plus a database copy exposes the stored tokens.
- The query log holds question text; it is the product's audit trail by
  decision D9 (kept forever) and lives only in the volume and the backups.
- Slack's user timezone can be stale; the label on every answer makes it
  visible rather than silent.
- Ephemeral delivery is not guaranteed by Slack; the slash command's answer
  may be missed if the user navigates away.
- Slack Connect guests of an installed workspace can ask; the information is
  free/busy only, by design.
- Admin availability on the tailnet: a client that keeps failing logins delays
  the owner's next attempt by up to 60 seconds per burst; it cannot lock the
  owner out (R4-1).
- Client addresses in the login log: the socket address is what the server
  saw (behind Docker's port publishing it is the bridge for every host client),
  the forwarded header is whatever the client or Tailscale Serve sent; both are
  recorded under distinct keys and neither is used as a security key (R4-2).
- The verifier refuses links, Slack markup and a reply that drops the owner's
  name or the zone; anything else a hallucinated reply could say is bounded by
  the time, date, bullet and polarity checks (R4-4).

## Admin sessions

Opaque 32-byte tokens, SHA-256 hashed at rest, 30-day TTL and 7-day idle
timeout, CSRF token per session, login attempts recorded in the database so
the progressive delay survives restarts, cookie `HttpOnly; SameSite=Lax`,
`Secure` over HTTPS. A fingerprint of the password (HMAC under the master
key, truncated, non-secret) is kept in `settings`: when it changes between
boots every session is deleted. "Log out everywhere" in Settings does the same
on demand.
