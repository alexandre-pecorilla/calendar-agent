# calendar-agent documentation

Documentation is a first-class deliverable: no change ships without its docs
updated in the same commit. **If unsure about a convention, read these files
rather than guessing.**

## Index

### For users and installers
- `../README.md` — what it is, what it will and will not do, quick start.
- `../DEPLOYMENT.md` — installing your own instance: single and multi mode, the Slack app, Tailscale Serve, operations, upgrades, troubleshooting.
- `user-guide.md` — how to ask the bot, in English. Share it with colleagues.
- `guide-utilisateur.md` — le guide utilisateur, en français.

### Architecture
- `architecture/configuration.md` — every variable, derivations, fail-closed rules.
- `architecture/data.md` — SQLite tables, encryption at rest, seeding, backups.
- `architecture/availability.md` — Cal.com calls, Google free/busy semantics, the free-window algorithm, rendering.
- `architecture/llm.md` — the two DeepSeek calls, prompts, verification, fixed replies, cost.
- `architecture/pipeline.md` — the single entry point every surface calls.
- `architecture/admin.md` — pages, authentication, sandbox.
- `architecture/slack.md` — modes, install flow, handlers, pitfalls.
- `architecture/security.md` — threat model, the fifteen controls and their proofs, residual risks.

### Development
- `development/repository-layout.md` — where everything lives.
- `development/testing.md` — suites, conventions, guards, evidence.
- `development/conventions.md` — code and documentation conventions.
- `development/release.md` — versioning, upgrades, key rotation.

### Records
- `testing/evidence/T1.md` … `T8.md` — evidence of each testing step; `live-*.txt` raw rows.
- `reviews/README.md` — what each review round covers; `reviews/R1.md` … `R4.md` — the reports with their fix passes.
- `../scopes_of_work/`, `../action_plans/`, `../testing_plans/` — the plans this build followed.

## Deviations from the plans

The plans are history once the build is accepted; where the code differs from
them on purpose, this list is the record (R3-20):

- "next Monday" / « lundi prochain » means the Monday strictly after today
  (said on a Monday, next week's); the scope's "nearest" reading made the same
  phrase mean today when said on that weekday. The convention is in
  `src/llm/prompts/parse.md`.
- The help reply is one paragraph in the asker's language, not two lines in
  both languages.
- No `oauth_states` or `rate_limits` tables: the OAuth state is the signed
  cookie of `@slack/oauth`, the limits are counted from `queries`.
- The manifest is rendered by `src/slack/manifest.ts` (`make manifest`), not a
  JSON template plus script; one parse prompt (`parse.md`) covers both
  languages; the sandbox needs no script; evidence files are `T<n>.md`.
- DeepSeek token caps are 1,500 (parse) and 600 (phrase), the timeout 30 s
  (D19, T4); a second empty parse answer is "cannot check right now", not a
  clarification.
- `make ask`, `make calcom-check` and `make deepseek-check` run inside the
  container against the instance's database (R3-3, R3-6); `make ask-host` is
  the host-side developer form.
