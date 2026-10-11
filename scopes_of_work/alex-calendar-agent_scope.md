# Scope of Work — alex-calendar-agent

> Status: APPROVED v3, 2026-10-09. v1 and v2 reviewed by the owner; v3 adds the uniform naming rule (§20), the addressing rules (§21), the Sandbox page (§10) and the documentation deliverables (§22). This document is the input for the action plan and the testing plan. Awaiting the owner's approval. Once approved, this document is the input for the action plan, then the testing plan, then the build. Nothing is built before each of those is approved in turn.

## 1. Context and problem

The owner (Alex) works with many clients at once. Each client provisions its own Google Workspace account, so Alex's calendar is spread over several Google calendars (client-a.example, client-b.example, client-c.example and others today; the count varies and must never be hardcoded).

Alex has connected all of them to one Cal.com account. Cal.com's "Check for conflicts" toggles decide which calendars count, and Cal.com's default schedule defines Alex's working hours. Cal.com is therefore the single, already-curated source of truth for "is Alex free".

The pain: people in Alex's Slack workspaces still email or message Alex to ask when Alex is free, then wait for a reply. The goal is to remove that round trip without exposing anything about Alex's calendar beyond free or busy.

## 2. Product vision (v1)

**alex-calendar-agent** is a Slack bot, installed in every Slack workspace Alex belongs to, that answers one kind of question in natural language, in English or French: *when is Alex available?*

It reads free/busy information from Cal.com, computes free windows inside Alex's working hours, and replies in the asker's language and timezone, always naming the timezone. It never books, never holds a slot, never shows event details, and never explains why Alex is busy. People still send Alex a calendar invite themselves.

A small web admin on the owner's machine shows every question asked and lets Alex set the API keys and a few parameters.

## 3. Hard constraints (non-negotiable)

1. **Free/busy only.** The bot's only data about the calendar is a list of busy intervals (start, end) from Cal.com plus Alex's schedule. Event titles, attendees, locations, descriptions and sources are never fetched, stored, logged or shown. The `source` field of Cal.com's busy-times response is discarded on receipt.
2. **Read only, no scheduling.** No booking, no slot reservation, no reschedule, no cancellation, no calendar writes of any kind. The Cal.com API key is used exclusively on read endpoints.
3. **No reasons.** The bot never says why Alex is busy. The one permitted qualifier is schedule-based: "outside Alex's usual hours" (and "Alex does not take meetings on that day"), because that is the schedule, not calendar content.
4. **Enforced in code, not in the prompt.** The LLM never receives any calendar data other than pre-computed free windows. There is nothing in its context that a prompt injection could leak.
5. **Cal.com is the only source of truth.** No direct Google access, no other calendar providers, no out-of-office or override sources beyond what Cal.com's default schedule already returns.
6. **Language and format follow the asker.** English question, English answer, 12-hour AM/PM times. French question, French answer, 24-hour "16h00" times. Every answer states the timezone it uses.
7. **Machine discipline.** The application lives in `/home/ubuntu/Is-Alex-Available` only. No other project or machine configuration is modified. The single machine-level change (one Tailscale Serve mapping) is a command written by Claude Code and run by Alex.
8. **Phase gating.** Scope of work, action plan, testing plan, build: each phase starts only after Alex approves the previous one.

## 4. Who can ask, and from where

Anyone who is a member of a workspace where the app is installed, including guests and Slack Connect participants. There is no allowlist in v1; everything the bot can reveal is free/busy, which is the intended audience's need.

Three entry points, each with Slack's recommended behaviour:

| Entry point | Trigger | Where the reply goes | Notes |
| --- | --- | --- | --- |
| Direct message to the bot | `message.im` event | Same DM | Plain reply |
| @mention in a channel | `app_mention` event | Thread under the question | Bot must be a channel member; Slack offers to add it on first mention |
| Slash command `/alex-calendar-agent` (same name as the bot, §20) | Slash command payload | Ephemeral message, visible to the asker only | Works in any channel without adding the bot. The "from everywhere" path |

Each question is self-contained (stateless v1). Follow-ups inside a thread ("and at 5?") are out of scope for v1 (see §14).

## 5. Question types and answer formats

The bot reports **free windows** (start to end), never slots. A duration is never required; when the asker states one, it filters the windows.

### 5.1 Shapes of questions

| Shape | Example | Answer |
| --- | --- | --- |
| Point in time | "Is Alex available Monday at 4 PM?" | Yes or no, the length of the window if yes, the next window if no |
| One day | "Quand est-ce qu'Alex est dispo mardi ?" | All windows of that day |
| Range | "Alex's availabilities next week except Wednesday?" | One line per day; days with nothing are stated as "no availability" |
| No date | "When is Alex free?" | The next 5 working days starting now, stated in the first line |
| With a duration | "Do you have an hour on Tuesday?" | Same as above, only windows of at least that length, stated in the first line |
| Off topic or detail seeking | "Why is he busy at 3?" | Fixed reply (§5.4), no LLM free text |

### 5.2 Examples

```
Yes, Alex is free Monday Oct 13 from 4:00 PM to 5:30 PM, New York time.
No, Alex is busy Monday Oct 13 at 4:00 PM. Next free window: 4:30 PM to 6:00 PM, New York time.

Disponibilités d'Alex mardi 14 octobre, heure de Paris :
• 9h00 à 11h30
• 14h00 à 17h00

Alex's availability next week, New York time:
• Mon Oct 13: 9:00 AM to 11:30 AM, 2:00 PM to 5:00 PM
• Tue Oct 14: 10:00 AM to 12:00 PM
• Thu Oct 16: all day, 9:00 AM to 6:00 PM
• Fri Oct 17: no availability
```

### 5.3 Rules applied to every answer

- Windows are exact, as returned by Cal.com intersected with the schedule (for example 2:15 PM). No rounding to slots.
- **Noise floor:** gaps shorter than 15 minutes are dropped. Adjacent or overlapping windows are merged.
- **Horizon:** questions may cover up to 4 weeks ahead. Beyond that the bot says how far it can look and asks for a narrower range. Past dates are refused politely.
- **Today:** the first window starts from now, rounded up to the next 5 minutes.
- **Range cap:** a range with more than 10 days of availability shows the first 10 days and invites the asker to name a week.
- **Outside the schedule:** a time outside working hours is answered "outside Alex's usual hours"; a day with no working hours (for example Saturday) is answered "Alex does not take meetings on that day".
- **Whole day free:** rendered as "all day, 9:00 AM to 6:00 PM" (schedule bounds).
- **Failure:** if Cal.com or the LLM cannot be reached, the bot says it cannot check right now. It never guesses.
- Both the noise floor and the horizon are settings in the admin (§9), with these defaults.

### 5.4 Fixed replies (no LLM)

- Off topic or asking for details: "I can only tell you when Alex is free or busy." / "Je peux seulement dire quand Alex est disponible ou non."
- Booking attempt: "I can't book anything. Please send Alex an invite directly." / "Je ne peux rien réserver. Envoyez directement une invitation à Alex."
- Empty mention or the slash command with no text: a one-line usage hint in both languages.

### 5.5 Date phrase conventions

| Phrase (EN / FR) | Meaning |
| --- | --- |
| today / aujourd'hui | from now to end of today's schedule |
| tomorrow / demain | next calendar day |
| this week / cette semaine | today through Sunday |
| next week / la semaine prochaine | next Monday through Sunday (working days shown) |
| Monday / lundi (no qualifier) | the next occurrence, today included if still ahead |
| next Monday / lundi prochain | same as above (ambiguity resolved in favour of the nearest) |
| morning, afternoon / matin, après-midi | before 12:00, 12:00 onward, in the asker's timezone |

The LLM resolves phrases against "now" expressed in the asker's timezone; the code validates the result.

## 6. Timezone and language rules

- **Default timezone: the asker's Slack profile timezone** (`tz` from `users.info`, requires `users:read`). A timezone or city named in the question overrides it ("in Paris time", "heure de Paris"). If the profile has no timezone, Alex's schedule timezone is used.
- **Always labelled.** Every answer carries a human label derived from the IANA zone, city based ("New York time", "heure de Paris"), on the first line of a listing and inline in a yes/no answer.
- **Language:** detected from the question text by the LLM; the Slack display locale (`include_locale`) is the tiebreaker for ambiguous one-word questions. Supported: English and French. Any other language is answered in English.
- **Formats.** English: "Mon Oct 13", "4:00 PM". French: "lundi 13 octobre", "16h00". Ranges use "to" / "à".

## 7. Availability computation (Cal.com API v2)

Authentication: API key in `Authorization: Bearer cal_live_…`, plus the `cal-api-version` header on every call (2024-08-13 by default; 2024-06-11 for the schedules endpoint, as its reference requires). Documented rate limit for API keys: 120 requests per minute, far above expected usage.

| Step | Endpoint | Cached |
| --- | --- | --- |
| Connected calendars with their `isSelected` flag, `credentialId`, `externalId` | `GET /v2/calendars` | 10 minutes |
| Working hours, timezone, date overrides | `GET /v2/schedules/default` | 10 minutes |
| Busy intervals for the selected calendars over the asked range | `GET /v2/calendars/busy-times?dateFrom&dateTo&timeZone&calendar=<credentialId>,<externalId>…` | Never (always fresh) |

Algorithm per question: build the working-hours intervals for each day in range from the schedule (overrides applied); subtract the busy intervals; drop windows under the noise floor; merge; filter by duration if given; clip to "now" and to the horizon; render.

**Only calendars with `isSelected = true` are passed** to busy-times, which mirrors Alex's "Check for conflicts" toggles exactly. Calendars other people shared with Alex are off in those toggles and therefore excluded. The duplicate toggle for dupont.us (shared view plus own account) only duplicates intervals and is harmless.

**Accepted / tentative / declined.** Cal.com exposes no response status and itself reads Google through the free/busy API only. The working assumption, to be verified in the testing plan with one test event per state: accepted, "maybe" and unanswered invitations are busy; declined invitations are free; events marked "Show me as: Available" are free; all-day events are free unless Alex marks them busy (Google's default). If a state does not behave as expected, the fix is on the Google Calendar side, never in the bot.

## 8. Language model (DeepSeek V4.1 Flash)

- Provider: DeepSeek, OpenAI-compatible API. Model: V4.1 Flash, **thinking effort low**, temperature 0. Exact model id, thinking parameter name and JSON output options are confirmed against DeepSeek's official documentation during the action plan (not indexed in the documentation MCP server).
- **Call 1, understand.** Input: the question, "now" in the asker's timezone, the asker's timezone and locale, Alex's schedule timezone. Output: strict JSON `{intent, range_start, range_end, excluded_weekdays, point_time, duration_minutes, language, timezone_override}`. Validated in code; anything invalid falls back to a clarification reply.
- **Call 2, phrase.** Input: the computed windows already formatted as strings in the right language and timezone, plus the intent. Output: the reply text. The code then verifies that every time string in the reply exists in the computed list; on mismatch the deterministic template is sent instead.
- The system prompts are static and benefit from DeepSeek prompt caching. Expected cost: well under one cent per question at published rates.
- Per-user rate limit: 10 questions per minute, then a polite "slow down" reply.

## 9. Slack application

- **Name, bot handle and slash command:** all `alex-calendar-agent`, derived from one value (§20).
- **Transport:** Socket Mode (app-level token with `connections:write`). No inbound port, no public URL for events.
- **Bot scopes (least privilege):** `app_mentions:read`, `chat:write`, `commands`, `im:history`, `im:read`, `im:write`, `users:read`. No user scopes.
- **Events:** `app_mention`, `message.im`.
- **Install modes (see §20):** `single` (bot token pasted in the env file, no OAuth routes, no HTTPS needed; the default for a colleague with one workspace) and `multi` (below; what Alex uses).
- **Multi-workspace (the an earlier internal project pattern, `multi` mode):** one app created once, from a manifest provided in the action plan, in a workspace where Alex is admin or owner. Public distribution activated. Every other workspace is connected through the OAuth install flow served by the app itself (Bolt installer: `/slack/install` and `/slack/oauth_redirect`), which stores one bot token per workspace. Socket Mode apps cannot be listed in the Slack Marketplace, but can be installed in any number of workspaces this way (Slack docs).
- **Redirect URL:** `https://myhost.tailnet-example.ts.net:8445/slack/oauth_redirect`, tailnet-only, reachable because Slack redirects Alex's own browser. Installs are done from a desktop browser (an earlier internal project's incident log: mobile loads the callback twice).
- **Per-workspace prerequisite:** Alex must be allowed to install apps there; some workspaces require admin approval.
- **Secrets:** client id, client secret, signing secret, app-level token and a state secret live in the env file. Workspace bot tokens are stored encrypted in the database.

## 10. Web admin

Password protected (one password in the env file, session cookie). Server-rendered pages, no frontend framework.

| Page | Content |
| --- | --- |
| Queries | Every question: timestamp, workspace, Slack user id and display name, entry point, question text, parsed intent, answer sent, response time, token usage and cost, error if any. Filters by workspace, user, date. Detail view. Kept forever. |
| Settings | DeepSeek API key, Cal.com API key (stored encrypted, shown masked), horizon (default 4 weeks), noise floor (default 15 min), per-user rate limit. "Test connection" for each key (Cal.com `GET /v2/me`, a minimal DeepSeek completion). |
| Workspaces | Connected workspaces, "Add to Slack" button (the install link), remove. Status line: Socket Mode connected or not, Cal.com reachable, list of calendars currently checked (ids and emails only), schedule timezone and hours. |
| Sandbox | A one-box chat that runs the exact same pipeline function as the Slack handlers, without Slack. Controls: asker timezone (short list plus any IANA zone), asker language (en/fr), optional "pretend now is" date-time. Output: the reply exactly as Slack would show it, plus a debug panel with the structured interpretation, the count of busy intervals, the computed free windows, the formatted strings given to the phrasing call, the verification result, latency, tokens and cost. Sandbox questions are logged with entry point `sandbox` and user `admin`; rate limits do not apply. Works before any Slack app exists (needs only the Cal.com and DeepSeek keys). |

Access: `http://myhost:8400` (daily use) and `https://myhost.tailnet-example.ts.net:8445` (same app behind Tailscale Serve). Health endpoint `GET /health` on the same port.

## 11. Data model (SQLite, one file in a Docker volume)

- `queries`: id, received_at, workspace_id, workspace_name, user_id, user_name, entry_point, channel_id, question, parsed_json, answer, language, timezone_used, latency_ms, prompt_tokens, completion_tokens, cost_usd, error.
- `settings`: key, value, encrypted flag, updated_at. API keys encrypted with a master key from the env file (envelope encryption, as in an earlier internal project).
- `slack_installations`: team_id, team_name, bot_token (encrypted), bot_user_id, installed_by, installed_at, removed_at.
- `oauth_states`: state, expires_at (single use, swept).
- `rate_limits`: user_id, window_start, count.

## 12. Hosting and operations

- **Docker Compose**, like every other project on the machine: one service `app`, one named volume `data`, one `.env` file, `restart: unless-stopped`. Node 24 LTS image, TypeScript, Bolt for JavaScript, a small HTTP framework for the admin and OAuth routes, better-sqlite3.
- **Ports.** The container listens on 8400. Published on `127.0.0.1:8400` (for Tailscale Serve) and on the host's Tailscale IP `100.64.0.1:8400` (what makes `http://myhost:8400` work). Nothing on the public interface, no ufw change, no host networking. Port 8400 is free today; this is re-checked at build time.
- **Tailscale Serve, run by Alex, once:** `tailscale serve --bg --https=8445 http://127.0.0.1:8400`. Ports 443, 8443 and 8444 stay as they are.
- **Env file** (`.env`, mode 600, never committed): owner first name and aliases; slash command; install mode; Slack app-level token and signing secret; in `single` mode the bot token, in `multi` mode client id, client secret, state secret and public base URL; admin password; master encryption key; port.
- **Makefile** with the same verbs as the other projects: build, start, stop, restart, logs, shell.
- **Logs:** container logs contain no question text and no answers, only structured events, counts, latencies and error codes. Content lives in the database only.
- **Backups:** the SQLite file in the volume; copying it is the backup.

## 13. Security and privacy

- Least-privilege Slack scopes; Cal.com key used on read endpoints only; DeepSeek receives no calendar data beyond formatted free windows.
- Secrets encrypted at rest, masked in the admin, absent from logs.
- Tailnet-only exposure for both URLs; admin behind a password on top.
- Prompt injection posture: there is no sensitive data in the LLM context to extract, and the reply is verified against computed data before posting.
- Slack request signatures are verified by Bolt; OAuth state is single use and time bounded.

## 14. Out of scope (v1)

Booking, holds, reschedules; thread memory and follow-up questions; notifications to Alex when someone asks; multi-person availability; calendars not connected to Cal.com; Cal.com out-of-office entries; Slack Marketplace listing; any public internet exposure; languages other than English and French; mobile or web UI for askers (Slack is the only interface).

## 15. Known risks and verifications

| Item | Risk | Handling |
| --- | --- | --- |
| Google declined / unanswered semantics | Behaviour not documented explicitly | Empirical test matrix in the testing plan; fix on the Google side if needed |
| All-day events default to "free" in Google | Vacation days may show as available | Alex marks them busy or uses Out of office; stated in the admin status page |
| Cal.com API key on the current plan | Docs do not state plan requirements | Verified with one `GET /v2/me` call before the build starts |
| DeepSeek model id and thinking parameter | Third-party sources only | Confirmed against DeepSeek's official docs in the action plan |
| Slack admin approval per workspace | Install may need approval | Handled per workspace by Alex; the app works in the others meanwhile |
| Tailscale IP binding at boot | Container may start before tailscaled | Restart policy retries; verified in the testing plan |
| Stale Slack timezone on a traveller | Wrong zone shown | The mandatory label makes it visible; the asker can name a zone |

## 16. Done when

1. From a DM, a channel mention and the slash command, in each connected workspace, the six question shapes of §5.1 return correct answers in both languages, in the asker's timezone, with the label.
2. No answer ever contains anything but times, dates, timezone labels and the fixed phrases.
3. The testing plan's free/busy matrix (accepted, maybe, unanswered, declined, "show as available", all-day) is executed and documented.
4. Calendars toggled off in Cal.com are provably excluded.
5. The admin shows every question with its answer, settings survive a restart, keys are masked, and the password is enforced.
6. `docker compose up -d` from the project directory brings everything up; the health endpoint is green; a container restart reconnects Socket Mode on its own.
7. Logs contain no message content.
8. The Sandbox page reproduces every Slack answer byte for byte for the same question and context, and its debug panel shows every stage.
9. The documentation set of §22 exists, is accurate against the running code, and a colleague can install the tool from the deployment guide alone.

## 17. What Alex provides before the build

1. The Slack app created from the provided manifest, in a workspace where Alex is admin, with public distribution activated and the redirect URL set; its credentials pasted into `.env`.
2. A Cal.com API key (Settings → Developer → API keys).
3. A DeepSeek API key.
4. The Tailscale Serve command run once.
5. Confirmation of `OWNER_NAME`, `OWNER_ALIASES` and, if different from the derived default, `BOT_NAME`.

## 18. Next phases

1. **Action plan**: file layout, dependencies, manifest JSON, env template, step-by-step build order, DeepSeek specifics confirmed.
2. **Testing plan**: unit tests for the window algorithm and renderers, the Google free/busy matrix, Slack surfaces per workspace, admin, restart and boot behaviour.
3. **Build**, only after both are approved.

## 19. What Claude Code reads before drafting the action plan

- `<earlier-internal-project>/docs/architecture/slack.md` and `<earlier-internal-project>/apps/server/src/slack/workspaces.ts` (read-only): the multi-workspace OAuth pattern and its pitfalls.
- `<internal-tool>/docker-compose.yml` and `Makefile` (read-only): compose and Makefile conventions on this machine.
- the documentation MCP server documentation slugs `cal-com` (API v2 calendars, schedules, AI agents guide) and `slack` (Bolt OAuth, Socket Mode, ephemeral replies, user object).

## 20. Distribution: one product, one instance per person

Added after the owner's review. Alex intends to give the tool to colleagues, each running their own copy.

- **Product name `calendar-agent`.** Code, image, docs and repository use the generic name. Each instance's Slack app follows the convention `<firstname>-calendar-agent`; Alex's is `alex-calendar-agent`. The project directory name is unchanged.
- **Configurable identity, in the env file.** Nothing is hardcoded: no owner name appears in code or prompts, a repository test fails the build if one does. Three variables, one required:

| Variable | Required | What it is | Used by |
| --- | --- | --- | --- |
| `OWNER_NAME` | yes | The human name, as written, e.g. `Alex` or `Jérôme` | Replies ("Alex is free…", "d'Alex"), the parser's notion of who the subject is, the usage hint |
| `OWNER_ALIASES` | no | Other names people may use, comma separated, e.g. `Alexandre, Alexandre Dupont` | The parser's "other person" check only |
| `BOT_NAME` | no | The one Slack identifier used for the app name, the bot handle and the slash command. Derived when absent: owner name lowercased, accents stripped, non-letters to hyphens, `-calendar-agent` appended (`Jérôme` → `jerome-calendar-agent`). Validated against Slack's slash-command rules: lowercase, letters, digits, hyphens, 32 characters max | App name, handle, slash command, the generated manifest, the admin header |

  The human name is the source and the Slack name is derived from it, never the reverse, because the slug loses capitalization and accents. The bot name is overridden only when two owners share a first name in one workspace. The manifest is rendered from these values by a make target. The admin Settings page shows them read-only; changing them means editing the env file, regenerating the manifest, updating the Slack app and restarting.
- **No gender or pronoun setting.** English replies always use the name, never "he" or "she". French replies use invariable phrasings ("disponible", "pas disponible", "a une disponibilité"), never "occupé(e)". Elision is computed ("d'Alex", "de Marie").
- **One instance per person, never multi-tenant.** Each colleague runs their own container with their own Slack app, Cal.com key and DeepSeek key. No person's free/busy passes through anyone else's instance.
- **Two install modes** (`INSTALL_MODE=single|multi`, §9). `single`: install from the Slack app page, paste the bot token, done; no HTTPS, no Tailscale, no open port. `multi`: the OAuth installer for several workspaces, needs an HTTPS redirect URL. Bolt supports both; the mode is one variable.
- **Mechanics.** A git repository (initialised in the action plan), a README written for a colleague who has never seen the tool, `.env.example`, a `make setup` path, tagged releases. Colleagues clone, fill the env file, render the manifest, create the Slack app from it, start the container.

## 21. How people address the bot

Nobody needs to say the owner's name. Each entry point already identifies whose calendar is meant: the DM is with the owner's bot, the @mention names the bot, the slash command is the owner's own.

- The parser treats any subject as the owner: the name, any alias, "you", "he", "she", "tu", "vous", "il", "elle", or no subject at all ("Monday at 4?").
- A question about someone else ("is Marie free Monday?") gets a fixed reply: this bot only knows the owner's availability.
- Replies are always in the third person ("Alex is free…"), so the bot never sounds like the owner speaking.
- "help", "aide", or an empty mention or slash command returns a two-line usage hint in both languages.
- Two agents in the same workspace never collide, because each has its own bot name and slash command.

## 22. Documentation deliverables

Documentation is a step of the action plan and of the testing plan, not an afterthought, following the conventions of the owner's other projects.

| Document | Audience | Content |
| --- | --- | --- |
| `README.md` | Anyone opening the repository | What it is, the hard constraints, quick start, links to every other document |
| `DEPLOYMENT.md` | A colleague installing their own instance | Prerequisites, `single` and `multi` install modes step by step, Slack app creation from the generated manifest, env file, Docker Compose, Tailscale Serve for `multi`, upgrades, backups, troubleshooting |
| `docs/user-guide.md` and `docs/guide-utilisateur.md` | End users in Slack, in English and in French | How to ask from a DM, a mention or the slash command, what the bot can and cannot answer, timezone behaviour, examples. Written so the owner can paste or link it to colleagues |
| `docs/architecture/*.md` | Maintainers | One file per concern: pipeline, availability computation, LLM layer and guardrails, Slack integration, admin and sandbox, data model, security and threat model, configuration |
| `docs/development/*.md` | Maintainers | Repository layout, testing, conventions, release process |
| `CLAUDE.md` | Claude Code sessions | Project rules extracted from this scope, binding for every session |
| `STATUS.md` | The owner | What is live, versions, known issues, last verified date |
| `.env.example` and `manifest.template.json` | Installers | Every variable documented inline; the manifest rendered from the env |

Every document is checked against the running code in the documentation step of the testing plan; a stale statement is a test failure.
