# calendar-agent — Installing your own instance

One instance per person, one directory and one `COMPOSE_PROJECT_NAME` per
instance (two instances on the same host need distinct project names and
`APP_PORT`s; the image tag and the volume follow the project name). You need:
Docker with Compose v2, Node 24 on the host (tests and the CLI), a Cal.com
account with your calendars connected and toggled under "Check for
conflicts", a DeepSeek API key, and a Slack workspace where you can create
apps.

## Table of contents

- [1. Clone and configure](#1-clone-and-configure)
- [2. Create the Slack app](#2-create-the-slack-app)
- [3. Single-workspace mode](#3-single-workspace-mode)
- [4. Multi-workspace mode](#4-multi-workspace-mode)
- [5. Build, start, verify](#5-build-start-verify)
- [6. Day-to-day operations](#6-day-to-day-operations)
- [7. Upgrades and backups](#7-upgrades-and-backups)
- [8. Troubleshooting](#8-troubleshooting)

## 1. Clone and configure

```bash
git clone <repository-url> calendar-agent && cd calendar-agent
make setup            # creates .env from .env.example and installs host dependencies
make key-generate     # prints a MASTER_KEY and a SLACK_STATE_SECRET to paste into .env
```

Edit `.env` (every variable is explained inside; comments go on their own
line, never after a value; see also `docs/architecture/configuration.md`).
For the next step only the identity part is needed: `OWNER_NAME`, optional
`OWNER_ALIASES` and `BOT_NAME`, `INSTALL_MODE`, and `PUBLIC_BASE_URL` in multi
mode. The Slack values come after the app exists.

- `OWNER_NAME` (your first name as it should appear in replies),
  `OWNER_ALIASES` (optional), `BOT_NAME` (optional, derived otherwise).
- `INSTALL_MODE=single` for one workspace (recommended to start), `multi` for several.
- `APP_PORT` and `APP_BIND_ADDRESSES`: keep `127.0.0.1`; add your machine's
  Tailscale IP to reach the admin at `http://<host>:<port>` over your tailnet.
  Never `0.0.0.0`.
- `ADMIN_PASSWORD` (at least 8 characters), `MASTER_KEY`, `CALCOM_API_KEY`
  (app.cal.com → Settings → Developer → API keys), `DEEPSEEK_API_KEY`
  (platform.deepseek.com → API keys). Leave a key you do not have yet empty:
  a half-filled value or the template's `...` is refused at start, and the two
  provider keys can also be pasted later in the admin Settings.

## 2. Create the Slack app

```bash
make manifest         # writes manifest.json from your .env
```

On https://api.slack.com/apps: **Create New App → From a manifest**, pick
your workspace, choose the **JSON** tab, paste `manifest.json`, Next, Create.
Then collect:

| Where | Value | `.env` variable |
| --- | --- | --- |
| Basic Information → App-Level Tokens → Generate (scope `connections:write`) | `xapp-…` | `SLACK_APP_TOKEN` |
| Basic Information → App Credentials | Signing Secret (optional: unused in Socket Mode, kept for a future HTTP receiver) | `SLACK_SIGNING_SECRET` |
| OAuth & Permissions → Install to Workspace → Allow | Bot User OAuth Token `xoxb-…` | `SLACK_BOT_TOKEN` |

## 3. Single-workspace mode

Nothing more: `INSTALL_MODE=single` with the three values above. No HTTPS,
no Tailscale, no open port. Go to section 5.

## 4. Multi-workspace mode

The bot can be installed into any workspace you belong to through Slack's
OAuth flow. Slack redirects your browser to an HTTPS address of this app, so
it needs one. On a machine with Tailscale, run once (as yourself; prefix with
`sudo` if it says access denied):

```bash
tailscale serve --bg --https=8445 http://127.0.0.1:8400     # adjust ports to APP_PORT / a free Serve port
```

Then in `.env`: `INSTALL_MODE=multi`, `PUBLIC_BASE_URL=https://<host>.<tailnet>.ts.net:8445`,
`SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` (Basic Information → App
Credentials), `SLACK_STATE_SECRET` (from `make key-generate`). Keep
`SLACK_BOT_TOKEN`: it seeds your home workspace. Re-run `make manifest` and
make sure the Slack app has the redirect URL
`<PUBLIC_BASE_URL>/slack/oauth_redirect` under OAuth & Permissions, then
**Manage Distribution → Activate Public Distribution**.

To add a workspace: open the admin **at the HTTPS address**
(`<PUBLIC_BASE_URL>/workspaces`, log in there if asked), click **Add to Slack**,
from a desktop browser, pick the workspace, Allow. The OAuth state cookie is
bound to that HTTPS origin, which is why the install cannot start from
`http://<host>:<port>` (the button redirects you there anyway). You must be
allowed to install apps in that workspace (some require an admin's approval).
The mapping persists across reboots; `tailscale serve status` shows it;
`tailscale serve --https=8445 off` removes it.

## 5. Build, start, verify

```bash
make build            # runs lint, typecheck, tests, the security gates and the docs check, then builds the image
make up               # starts the container and waits for health
make status           # health JSON: slackConnected, workspaces
make calcom-check     # live, inside the container: the Cal.com key the instance uses, selected calendars, schedule
make deepseek-check   # live, inside the container: one tiny completion with the DeepSeek key the instance uses
make ask q="is <name> free Monday at 4pm?"   # the engine inside the container; the question appears in the admin Queries (entry point cli)
```

The three checks run inside the running container, so they test exactly the
keys the instance uses (admin Settings first, `.env` as the first-boot seed).
`make ask-host` is the developer form on the host: it uses `./data` and the
keys of `.env`, and its questions are not in the admin.

Open `http://127.0.0.1:<port>` (or the Tailscale address) and log in with
`ADMIN_PASSWORD`. **Sandbox** runs the exact pipeline Slack uses: test there
first. Then in Slack: DM the bot, mention it in a channel it was added to, or
type `/<bot-name> is <name> free tomorrow at 10?` anywhere.

## 6. Day-to-day operations

`make help` lists everything. `make logs` (no question or answer text ever
appears there), `make ps`, `make restart` after editing `.env`, `make rebuild`
after a code update. Provider keys can be rotated in the admin Settings; the
env values are only a first-boot seed, so once seeded a change of
`CALCOM_API_KEY` or `DEEPSEEK_API_KEY` in `.env` is ignored: rotate them in
Settings. Changing `MASTER_KEY`: see `docs/development/release.md`.

### Surviving a reboot

The container restarts on its own after a reboot (`restart: unless-stopped`)
**unless** it publishes on the Tailscale IP and Docker starts before Tailscale
has assigned that address: Docker then fails to create the port mapping,
records a failed start, and never retries. If `APP_BIND_ADDRESSES` lists the
Tailscale IP, make Docker wait for Tailscale once, on the host:

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/wait-for-tailscale.conf >/dev/null <<'EOF'
[Unit]
After=tailscaled.service
Wants=tailscaled.service

[Service]
ExecStartPre=-/usr/bin/timeout 60 /bin/sh -c 'until ip -4 addr show tailscale0 2>/dev/null | grep -q "inet "; do sleep 1; done'
EOF
sudo systemctl daemon-reload
```

Docker then starts after the Tailscale address exists (it gives up waiting
after 60 s so Tailscale being down never blocks the other containers). It
takes effect at the next boot; nothing needs restarting now. With
`APP_BIND_ADDRESSES=127.0.0.1` alone this is not needed.

## 7. Upgrades and backups

```bash
git pull && make rebuild      # image rebuilt, container recreated, data volume kept
make compile                  # only if you use make manifest or make ask-host on the host: refresh dist/
make db-backup                # consistent snapshot to ./backups/ (keep MASTER_KEY with it)
```

Restore: `make db-restore f=backups/<file>.db`. It stops the app, deletes the
database's `-wal` and `-shm` files in the volume (a stale write-ahead log would
otherwise be replayed onto the restored file), copies the backup over
`calendar-agent.db` and starts the app. The master key must be the same one.

## 8. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Startup says `Invalid configuration: X` | A variable is missing or malformed in `.env` (values are never printed). `.env.example` is the commented template (`make env` recreates `.env` from it only when the file is missing). |
| Startup says `X still hold the template placeholder` | The line still ends with `...` as in the template: paste the real value or leave it empty. |
| `make up` prints `FAIL <ip>:<port> error:EADDRNOTAVAIL` | That address is not on this machine right now (Tailscale down or not up yet): check `tailscale status` and retry, or remove the IP from `APP_BIND_ADDRESSES`. |
| After a reboot the container is `Exited (128)` with `failed to bind host port <tailscale-ip>:<port>` | Docker started before Tailscale had the address and does not retry a failed start. `make restart` brings it back now (`make up` alone may reuse the half-created network and leave the container without ports or egress); install the "Surviving a reboot" drop-in in §6 so it does not happen again. |
| `MASTER_KEY looks like a placeholder` | Generate a real one: `make key-generate`. |
| Login says `Too many failed attempts. Try again in N seconds` | Each wrong password delays the next attempt (1 s doubling to 60 s). Wait the seconds shown; a right password clears it. Someone else on the tailnet hammering the login can delay you by at most a minute at a time. |
| The admin logged me out after I changed `ADMIN_PASSWORD` | By design: a password change ends every session. Log in again with the new one. |
| `/health` shows `slackConnected: false` | At boot: wrong or revoked `SLACK_APP_TOKEN`, or Socket Mode disabled on the app. Later: the socket was lost and is reconnecting (the Workspaces page shows since when). Check `make logs`. The Docker healthcheck only tests HTTP, so the container stays "healthy" meanwhile. |
| The bot does not answer a DM | The Messages tab must be enabled (the manifest does it); the app must be installed in that workspace (Workspaces page). |
| Mention in a channel ignored | The bot must be a member of that channel: `/invite @<bot-name>`. |
| Slash command "dispatch_failed" | The app is not running or not connected. |
| Install page says `slack_oauth_invalid_state` | The install was not started from the HTTPS address (`<PUBLIC_BASE_URL>/workspaces`), or on a phone the callback loaded twice and the first load succeeded. Check Workspaces; start from the HTTPS address on a desktop browser. |
| Install page says `slack_webapi_platform_error (bad_client_secret)` | The client secret was regenerated in the Slack app; update `.env` and `make restart`. Existing workspaces keep working. |
| Install page says `slack_webapi_platform_error (invalid_code)` or `(code_already_used)` | The callback was reloaded or the code expired; start again from Add to Slack. |
| Cannot remove the home workspace (no Remove button) | `SLACK_BOT_TOKEN` in `.env` re-seeds it at every start; delete the variable and restart to remove it for good. |
| Answers say "cannot check right now" | Cal.com or DeepSeek unreachable or key rejected: Settings → Test connection; the query detail shows the error code. A key edited in `.env` after the first start is not applied: paste it in Settings. |
| Settings shows a key as "unreadable", Workspaces lists a workspace as "unreadable", the log warns about a previous `MASTER_KEY` | The master key changed: paste the provider keys again in Settings, re-install or remove the listed workspaces, or put the previous key back (`docs/development/release.md`). |
| All-day vacations show as available | Google defaults all-day events to Free; set them to Busy or use Out of office. |
