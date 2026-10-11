# Releases and upgrades

- Version in `package.json`; git tags `vX.Y.Z` for releases after 1.0.0 (the
  build-era tags `v0.1.0`/`v1.0.0` went with the original history).
- Upgrade an instance: `git pull && make rebuild`. The data volume and the
  database are kept; migrations run at boot. Take `make db-backup` first.
- Changing the Slack manifest (scopes, events, names) means updating the app on
  api.slack.com; existing installations keep working with their scopes until
  reinstalled.
- Rotating keys: Cal.com and DeepSeek in the admin Settings; Slack tokens by
  editing `.env` and `make restart`; `ADMIN_PASSWORD` by editing `.env` and
  `make restart`, which also ends every admin session (R4-8).
- The base image is pinned by digest in the `Dockerfile` (R4-9). To bump it:
  `docker pull node:24-alpine`, read the new digest with
  `docker image inspect node:24-alpine --format '{{index .RepoDigests 0}}'`,
  update the `FROM` line, `make rebuild`.
- Rotating `MASTER_KEY` (R3-1): every value encrypted with the old key becomes
  unreadable, and the app treats such rows as absent rather than failing
  (`/health`, Settings and Workspaces keep working; the boot log warns). Procedure: `make db-backup`; change `MASTER_KEY` in `.env`;
  `make restart`. Then: the Cal.com and DeepSeek keys are re-seeded from `.env`
  if still there, otherwise Settings shows them as "unreadable" and you paste
  them again; the home workspace is re-seeded from `SLACK_BOT_TOKEN`; any other
  workspace is listed as "unreadable" on the Workspaces page and must be
  re-installed (Add to Slack) or removed. To undo, put the previous key back
  and `make restart`: nothing is lost until a row is overwritten.
