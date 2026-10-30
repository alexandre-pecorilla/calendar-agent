# The pipeline

`AnswerPipeline.ask(context, text)` in `src/pipeline/answer.ts` is the single
entry point. Slack handlers, the admin sandbox and `make ask` all call it with
a context (who asks, from where, their Slack timezone and locale, an optional
injected "now") and the raw text.

1. **Sanitise** (`src/security/input.ts`): mention and link markup removed,
   entities decoded, 500-character cap, control tokens neutralised. Empty →
   help reply.
2. **Limits** (`src/pipeline/rate-limit.ts`): per user 10/min, per workspace
   60/min, global 100/min, daily budget 2,000 (all admin settings), computed
   from the query log, once per question. Sandbox and CLI never count, nor do
   questions refused by a limit. The budget day is the UTC day.
3. **Schedule**: the owner's default Cal.com schedule (cached 10 min) gives
   the owner zone; the asker zone defaults to it when Slack has none.
4. **Parse** (call 1) → schema → fixed replies for non-availability intents.
5. **Zone and language**: a zone named in the question (canonical `Area/City`,
   or a known abbreviation such as EST or CET mapped to one) wins; an unusable
   zone name yields a clarification rather than a silent fallback; else the
   asker's Slack zone, else the owner's. Language from the question, else the
   Slack locale, else English.
6. **Request building**: dates interpreted in the zone; past → fixed; start
   beyond the horizon (28 days) → fixed; end clipped to the horizon; a
   single-day range becomes a day question. Slots (1.2.0): every start must
   parse, a span must end after its start and within a day, duplicates are
   dropped; the fixed "past" or "horizon" reply only when every slot is past
   or every slot is beyond the horizon, otherwise each slot gets its own line.
7. **Availability** (`docs/architecture/availability.md`) with busy times of
   the selected calendars, fetched fresh.
8. **Render** deterministically. A yes/no answer is then **phrased** (call 2)
   and **verified**; a listing or a slots answer is posted as rendered (1.2.0).
9. **Log** one row in `queries` with the question, interpretation, answer,
   zone, language, latency, tokens, cost and error code. Container logs get
   ids and numbers only.

Errors: Cal.com or DeepSeek failures of any kind produce the "cannot check
right now" reply in the asker's language; the error code is stored with the
query and logged without content.
