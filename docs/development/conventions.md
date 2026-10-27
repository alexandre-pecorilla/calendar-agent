# Conventions

- TypeScript, ESM, `strict` with `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`; Prettier formatting; ESLint recommended rules.
- One module per concern under `src/`; modules import downwards only
  (config → db/crypto → calcom/availability → llm → pipeline → slack ↔ admin:
  the installer routes and the status object are shared between the last two;
  nothing below imports either).
- Every HTTP call to a provider goes through its client module; there is one
  `fetch` for Cal.com and one `OpenAI` client for DeepSeek.
- Nothing about the owner in code or prompts: `OWNER_NAME`, `OWNER_ALIASES`,
  `BOT_NAME`. Prompts are templates with `{{PLACEHOLDERS}}`.
- Logs are structured, with ids, counts, durations and error codes; never
  question or answer text, never a secret. Content lives in SQLite only.
- Replies: English and French, third person, the timezone label always
  present, no reasons, no event details.
- Documentation ships with the change: `docs/README.md` indexes every document;
  `STATUS.md` says what is live; `CLAUDE.md` binds every session.
- Commits: `S<n>:`, `T<n>:`, `R<n>:`, `feat:`, `docs:`, `fix:`; `make check` green
  before each.
