# Slack integration

`src/slack/`. Bolt for JavaScript in **Socket Mode**: the app opens an
outbound WebSocket to Slack with the app-level token; events and slash
commands arrive over it. No inbound URL, no open port, nothing public.

## Identity

The app name, the bot handle and the slash command are all `BOT_NAME`
(derived from `OWNER_NAME`, see `configuration.md`). `make manifest` renders
`manifest.json` from `.env`; the app is created from it on api.slack.com.

## Permissions (`scopes.ts`)

Bot scopes only: `app_mentions:read`, `chat:write`, `commands`, `im:history`,
`im:read`, `im:write`, `users:read`. Events: `app_mention`, `message.im`. No
user scopes, no channel history: the bot sees DMs sent to it and messages it
is mentioned in, nothing else. The repository guard
`tests/repo/slack-scopes.test.ts` fails on any change.

## Install modes

| Mode | How a workspace gets its bot token | Needs |
| --- | --- | --- |
| `single` | "Install to Workspace" on the Slack app page; the token is pasted in `.env` as `SLACK_BOT_TOKEN`; at boot `auth.test` finds the team id and the token is stored encrypted | nothing else |
| `multi` | The OAuth installer: `GET /slack/install` (admin session) redirects to Slack's authorisation page with the allowlisted scopes and a signed state; Slack redirects the installer's browser to `GET /slack/oauth_redirect` on the HTTPS `PUBLIC_BASE_URL`; `@slack/oauth` verifies the state, exchanges the code and the store encrypts the bot token. `SLACK_BOT_TOKEN`, when present, still seeds the home workspace | client id and secret, a state secret, an HTTPS redirect (Tailscale Serve on the owner's machine) and public distribution activated on the app |

The same pattern as an earlier internal project: one app, created once in a workspace where the
owner is admin, installed anywhere afterwards. The state is kept by
`@slack/oauth` in a `Secure`, host-only cookie, so the flow must start on the
HTTPS origin of `PUBLIC_BASE_URL`: the Workspaces button links there and an
install request on any other origin is redirected there first (R2-1).
Pitfalls surfaced on the failure page with the real codes: `slack_oauth_invalid_state`
(started from the wrong origin, or a phone loading the callback twice after a
real success); `slack_webapi_platform_error` with the Slack reason in brackets,
`bad_client_secret` (secret regenerated in the Slack app, `.env` stale; existing
workspaces keep working) or `invalid_code` / `code_already_used` (reloaded
callback). Hijacked replies carry the same security headers as every page.

## Runtime

- `authorize` resolves the bot token for the workspace an event came from
  (`slack_installations`, token encrypted with the team id as AAD). An
  unknown workspace is refused; one workspace can never use another's token.
- `handlers.ts`: DM → reply in the DM; @mention → reply in a thread under the
  message (`thread_ts ?? ts`); slash command → acknowledged at once with an
  ephemeral placeholder, then the answer replaces it (`replace_original`).
  Bot messages, edits and non-DM messages are ignored. Every path calls the
  single pipeline; a failure becomes the "cannot check" reply, never an
  exception into Bolt.
- `users.info` (with locale) gives the asker's timezone, language and name,
  cached one hour per user; failure degrades to the owner's zone and English.
- The Socket Mode connection state is mirrored into the runtime status shown
  on `/health` and the Workspaces page: `connected` sets it, and
  `reconnecting`, `disconnecting` or `disconnected` clear it (with auto-reconnect
  the client emits `reconnecting`, never `disconnected`, on an unexpected loss);
  Bolt reconnects automatically and the page shows "reconnecting since".
- Slack's 3-second rule: the command is acknowledged before the pipeline runs;
  event handlers acknowledge by returning.

## Removing a workspace

The admin's Workspaces page forgets the token (`removed_at`). The app must
also be removed from that workspace's Slack settings; otherwise Slack keeps
delivering events that `authorize` refuses. The workspace seeded from
`SLACK_BOT_TOKEN` is re-seeded at every start while the variable exists, so the
page offers no Remove button for it: delete the variable and restart. If the
env token later belongs to another workspace, the boot log warns about the
stale env-seeded row.
