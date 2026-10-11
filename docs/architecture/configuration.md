# Configuration

Every variable is read once at boot by `src/config/env.ts` (zod). Validation
fails closed with a message naming the variable, never its value. Empty strings
for optional variables count as unset.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `OWNER_NAME` | yes | | Human name used in replies and recognised by the parser |
| `OWNER_ALIASES` | no | empty | Comma separated; quote the value if it contains spaces |
| `BOT_NAME` | no | derived | `slug(OWNER_NAME)-calendar-agent`, trimmed to 32 chars; must match `^[a-z0-9][a-z0-9-]{0,31}$` |
| `INSTALL_MODE` | no | `single` | `single` needs `SLACK_BOT_TOKEN`; `multi` needs client id/secret, state secret and an https `PUBLIC_BASE_URL` |
| `APP_PORT` | no | 8400 | Container and host port |
| `APP_HOST` | no | 127.0.0.1 | Bind address inside the process; compose sets 0.0.0.0 inside the container |
| `APP_BIND_ADDRESSES` | no | 127.0.0.1 | One or two host addresses the port is published on; wildcards refused |
| `PUBLIC_BASE_URL` | multi | | HTTPS base of the OAuth redirect |
| `SLACK_APP_TOKEN` | yes | | `xapp-…`, Socket Mode |
| `SLACK_SIGNING_SECRET` | no | | Unused in Socket Mode (no HTTP receiver); accepted for a future one |
| `SLACK_BOT_TOKEN` | single | | `xoxb-…`; in multi mode seeds the home workspace |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` | multi | | |
| `ADMIN_PASSWORD` | yes | | ≥ 8 characters; hashed with scrypt at boot |
| `MASTER_KEY` | yes | | base64, 32 bytes; placeholder-like keys refused (S2) |
| `CALCOM_API_KEY`, `DEEPSEEK_API_KEY` | no | | Seeded into encrypted settings at first boot; a template placeholder (ending in `...`) is refused |
| `LOG_LEVEL` | no | info | `fatal`, `error`, `warn`, `info`, `debug`, `trace`; the Slack libraries' debug output (full event payloads) is discarded at every level, so no question text reaches the log |
| `DATA_DIR` | no | ./data | `/data` in the container |
| `SLACK_ENABLED` | no | true | `false` runs the admin and sandbox without Slack (tests) |

A value that ends in `...` (the template placeholder) is refused for every
secret variable, with the variable's name and never its value.

Derived values: `botName`, `slashCommand` (`/` + botName), `ownerAliases[]`,
`bindAddresses[]`.

Identity rules (`src/config/identity.ts`): slug = NFD, accents stripped,
lowercase, non-alphanumerics → `-`; French elision `d'Alex` / `de Marie`;
English possessive `Alex's`.
