# The language model layer

DeepSeek V4.1 Flash (`deepseek-flash`) through its OpenAI-compatible endpoint,
thinking on at effort `low`, temperature 0, via the `openai` SDK
(`src/llm/deepseek.ts`). Sources: DeepSeek's official reasoning and JSON-mode
guides and pricing page (2026-10-09), cross-checked with an earlier internal project's live-verified
provider table. **No call ever declares a tool or a function**; the model can
only return a JSON object or a short text, so there is no path from the model
to any API (CLAUDE.md §2, verified by `tests/repo/no-llm-tools.test.ts`).

## Call 1 — understand (`src/llm/parse.ts`, prompt `prompts/parse.md`)

The only call that sees the asker's text. The system prompt is built from the
configuration (owner name, aliases, "now" and today in the asker's zone, the
owner's zone) and asks for one JSON object; the word "json" and two examples
are in the prompt as DeepSeek's JSON mode requires. The user message is the
sanitised question only.

Output schema (zod, `parsedQuestionSchema`): `intent` ∈ point | day | range |
open | other_person | self | booking | help | off_topic; `language` ∈ en | fr |
other; `timezone_override` IANA or null; `point_time` `YYYY-MM-DDTHH:MM`;
`range_start`/`range_end` `YYYY-MM-DD`; `excluded_weekdays`; `part_of_day`;
`duration_minutes` 5–720. Field-level failures fall back to null (`.catch`),
an invalid `intent` or non-JSON output yields the clarification reply. The
pipeline then validates semantics: past, beyond the horizon, end before start,
missing fields.

Any grammatical person refers to the owner; "other_person" and "self" are the
only subjects that produce a fixed refusal. Aliases only widen the set of
names that mean the owner.

## Call 2 — phrase (`src/llm/phrase.ts`, prompt `prompts/phrase.md`)

Receives the deterministic draft produced by the renderer and nothing else:
the asker's question never reaches it. It may add one lead sentence and must
keep every time, date, label (flag included), qualifier and bullet line
verbatim, bold and emoji where the draft has them, and add no markup of its
own. **Thinking is
off for this call** (D19): rewriting needs no reasoning, and measured live on
2026-10-09 the thinking version spent 450–750 reasoning tokens and 3–5 s per
reply where the thinking-off version takes under a second for the same verified
output. Call 1 keeps thinking at effort `low`.

## Token caps

Reasoning tokens are counted inside `max_tokens` (verified live: a 20-token
cap returned `finish_reason: length` with empty content). Caps: 1,500 for the
parse call, 600 for the phrase call; an empty answer is retried once with a
doubled cap; a second empty answer from the parse call becomes the "cannot
check right now" reply, logged with error `deepseek:empty` (the plan said
"clarify"; a failed parse is a provider failure, not a user problem), and from
the phrase call the deterministic draft is posted as is.

The date-phrase conventions the parser follows (this week, next week, bare
weekday, "next Monday" = strictly after today, morning / afternoon / evening,
"4" means 4 pm) live in `src/llm/prompts/parse.md`, section "Date
conventions"; that file is the reference, this document does not repeat it.

## Verification (`src/llm/verify.ts`)

The reply is accepted only if (tightened after review R1-2):

- every time it mentions, in any spelling the regexes recognise (`4:00 PM`,
  `4 PM`, `4.30pm`, `16h30`, `16 h 30`, `16h`, 24-hour `15:00`, the words
  midnight/noon/minuit/midi), normalises to a time the renderer produced, and
  the **ordered sequence** of times equals the draft's sequence exactly (no
  swap, no repeat, no omission);
- every date it mentions (`Mon Oct 12`, `Monday Oct 12`, `lundi 12 octobre`)
  is one the renderer produced, and every date of the draft is present;
- its bullet lines are exactly the draft's bullet lines, in the same order;
- a yes/no answer keeps its verdict (yes-words and no-words checked);
- every required phrase is present: the timezone label (flag included) always, plus the
  qualifiers the draft carried (the duration such as "1 hour" / "1 h", every
  excluded weekday name, the part of day);
- it is under 1,500 characters and contains no link.

Otherwise the draft itself is sent. The sandbox and the query log show which
happened and why.

## Fixed replies (`src/pipeline/fixed-replies.ts`)

Never generated: other person, self, booking, off topic, help, clarify, rate
limited, over capacity, cannot check, past, beyond horizon. EN and FR; the
owner's name and the French elision come from the configuration.

## Cost

Usage from each response (`prompt_tokens`, `completion_tokens`,
`prompt_cache_hit_tokens`) priced with DeepSeek's published rates, peak
(01:00–04:00 and 06:00–10:00 UTC, Monday to Friday) or off-peak, and stored
per question. Thinking tokens are billed as output by DeepSeek and are counted.
