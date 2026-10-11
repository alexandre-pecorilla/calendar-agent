# Testing

## The suites

| Suite | Where | Runs with | Needs |
| --- | --- | --- | --- |
| Unit | `tests/unit/` | `make test` | nothing; pure functions, fixtures, injected "now" |
| Integration | `tests/integration/` | `make test` | in-memory SQLite, mock Cal.com and scripted DeepSeek servers on loopback, Fastify `inject` |
| Repository guards | `tests/repo/` | `make test` | the source tree: allowlists and hygiene rules that fail the build on purpose |
| Live | `tests/live/` | `make test-live` (`LIVE=1`, loads `.env`) | the owner's keys; the running container for the container suites; cheap and read-only |

`make check` = lint + typecheck + `make test` + secrets scan + private-words
check + `npm audit` + `make docs-check`.

The private-words check (`scripts/check-private-words.mjs`) reads the owner's
real terms (e-mail, client domains, tailnet name, workspace id, client names)
from `.private-words` at the repository root: gitignored, one term per line,
`#` for comments, case-insensitive plain text. It fails on any of them in a
file name, a file the repository tracks or would add, or the message of a
commit not yet pushed, and reports only where and which line of the list,
never the term. Without the file (CI, a fresh clone) it is skipped. The
pre-push hook in `.githooks/` runs it too; `make hooks` installs it once per
clone.
It runs before `make build` and must be green before any commit that ends a
step.

## Conventions

- **"Now" is always injected.** No test reads the wall clock; dates in
  fixtures are real 2026 dates with the right weekdays.
- Fixtures live in `tests/fixtures/` (schedules, the question corpus, the
  injection corpus).
- Live tests write their rows to `docs/testing/evidence/*.txt` so the evidence
  files can quote them; they never write secrets.
- A test that looks like a credential to the secrets scanner (long `xoxb-…`,
  `cal_live_…` with 16 hex characters, `apiKey: "…12+ chars"`) must use a
  shorter or differently shaped value.
- DeepSeek is exercised live, not mocked, when the prompts are the thing under
  test (corpus, injections); it is scripted when the contract around it is
  (error mapping, verification fallback).

## Repository-hygiene tests

`calcom-allowlist` (GET only, four paths, one fetch), `no-llm-tools`,
`no-owner-literal`, `slack-scopes`, `deployment-hardening` (compose hardening,
the environment allowlist, the `.env.example` comment rule), `scripts-and-cli`
(the host scripts and CLIs read `.env` like the app; `make -n` never executes
anything). Changing a guarded
fact means changing the guard on purpose, in the same commit, with the reason.

## Evidence and reviews

Every testing step leaves `docs/testing/evidence/T<n>.md`; every review round
leaves `docs/reviews/R<n>.md` with findings, severities and fix commits.
