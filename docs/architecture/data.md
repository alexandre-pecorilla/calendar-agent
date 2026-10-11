# Data

One SQLite file, `calendar-agent.db` in `DATA_DIR` (`/data` in the container, a
named Docker volume), opened with Node's built-in `node:sqlite` driver (no native
build). WAL journal, foreign keys on, 5 s busy timeout. Migrations are numbered
SQL files in `src/db/migrations/`, applied at boot in order, each in a
transaction, recorded in `schema_migrations`; re-running is a no-op.

## Tables

| Table | Purpose | Sensitive columns |
| --- | --- | --- |
| `settings` | Key/value configuration editable in the admin | `value` is AES-256-GCM ciphertext when `encrypted = 1` (`calcom_api_key`, `deepseek_api_key`) |
| `queries` | Every question asked, kept forever: who, where from, the question, the structured interpretation, the answer, language, timezone, latency, tokens, cost, error | `question`, `answer` (content; never logged elsewhere) |
| `slack_installations` | One row per connected workspace; `removed_at` marks a removal | `bot_token_enc` ciphertext (AAD = team id) |
| `sessions` | Admin sessions: SHA-256 of the cookie token, CSRF token, expiry | none in clear |
| `login_attempts` | Failed/successful admin logins for the lockout | none |
| `slack_user_cache` | `users.info` timezone, locale and name per user, 1-hour cache | none |

## Encryption at rest

`src/crypto/envelope.ts` (ported from an earlier internal project): `v1.<key-id>.<iv>.<ciphertext>.<tag>`,
AES-256-GCM, 96-bit IV, 128-bit tag, the setting key or team id as associated
data so a ciphertext cannot be moved to another row. The master key is
`MASTER_KEY` in `.env` (32 bytes base64, placeholder-like keys refused at boot) and
exists nowhere else. A copied database is inert without it.

`src/crypto/secret.ts`: values read back are wrapped in `Secret`, which prints
`[secret]` under `console.log`, JSON and `util.inspect`; `masked()` shows the
last four characters for the admin.

The key id in every ciphertext (`k1`) is a format label, not a fingerprint of
the key: a value encrypted with another master key fails on the GCM tag and is
reported as unreadable (R4-9).

## Seeding

At first boot, `CALCOM_API_KEY` and `DEEPSEEK_API_KEY` from `.env` are imported
into `settings` encrypted, only if absent from the database (a row the current
master key cannot read counts as absent; a template placeholder ending in
`...` is never seeded). A value rotated in the admin is never overwritten by
the env file; the env values can then be removed. The CLIs (`make ask`,
`make calcom-check`, `make deepseek-check`) run inside the container and read
the same database, so they always test the key the instance uses.

## Backups

`make db-backup` runs SQLite's online backup API (`node:sqlite` `backup()`,
a consistent snapshot while the app runs) inside the container and copies the
file to `./backups/` (gitignored). `make db-restore f=…` stops the app, deletes
the `-wal` and `-shm` files in the volume (a stale write-ahead log would be
replayed onto the restored file), copies the backup over
`/data/calendar-agent.db` and restarts. The master key must be the same one.

The host copy is created with mode `600` in a `backups/` directory of mode
`700` (R4-7): it holds the query log in clear by decision D9.
