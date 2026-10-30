# Availability

How "when is the owner available?" is computed. Everything here is pure code;
the LLM is not involved (see `llm.md` for what it does).

## Cal.com calls (`src/calcom/client.ts`)

The client is the whole Cal.com surface of the application: GET only, four
allowlisted paths, nothing else (CLAUDE.md §2, enforced by
`tests/repo/calcom-allowlist.test.ts`). Headers on every call:
`Authorization: Bearer <api key>` and `cal-api-version` (`2024-08-13`, or
`2024-06-11` for the schedules endpoint, per the API v2 reference).

| Call | Endpoint | Cached | Used for |
| --- | --- | --- | --- |
| `me()` | `GET /v2/me` | no | key verification only |
| `calendars()` | `GET /v2/calendars` | 10 min | the `isSelected` flag of every connected calendar = the owner's "Check for conflicts" toggles |
| `defaultSchedule()` | `GET /v2/schedules/default` | 10 min | timezone, weekly hours, date overrides |
| `busyTimes()` | `GET /v2/calendars/busy-times?dateFrom&dateTo&timeZone&calendar=<credentialId>,<externalId>…` | never | busy intervals of the **selected** calendars only |

Observed live (2026-10-09): Cal.com returns intervals from the day before `dateFrom` as well, and clips at `dateTo` rather than covering it fully (an all-day block on `dateTo` came back cut at 10:00 local). The engine therefore requests `dateFrom = range start − 1 day` and `dateTo = range end + 1 day`, where the range end is already the exclusive day after the last asked day.

Busy-times responses are parsed with a schema that keeps `start` and `end`
and strips everything else; the `source` field never enters the process.
Retries: two, with backoff, on network errors, 429 and 5xx. 401/403 is
surfaced as `unauthorized`, anything unexpected as `bad_response`.

Cal.com itself reads Google through the free/busy API, so an event counts as
busy according to Google's rule: accepted, "maybe" and unanswered invitations
and any event marked Busy are busy; declined invitations and events marked
Free are free; all-day events are Free unless marked Busy. Overlapping events
are unioned: a minute is busy if any busy interval covers it.

## Algorithm (`src/availability/`)

1. **Timezone** (`timezone.ts`): a zone named in the question wins, else the
   asker's Slack zone, else the owner's schedule zone. The label
   ("New York time" / "heure de Paris") is always rendered.
2. **Working intervals** (`schedule.ts`): for each schedule-zone day in the
   range ±1 day, the date overrides for that date if any, else the weekly
   rules for that weekday; `HH:MM` converted in the schedule zone; merged and
   clipped to the absolute range. A day with no rule has no hours.
3. **Busy intervals**: fetched for the schedule-zone dates covering the range
   ±1 day, parsed as UTC instants, merged.
4. **Free windows** (`windows.ts`): working − busy, clipped to `max(range
   start, now rounded up to 5 minutes)`, windows shorter than the noise floor
   (15 min) or than a requested duration dropped, adjacent windows merged.
   Intervals are computed one day wider than the asked range on each side, so
   that a window crossing midnight keeps both ends; the listing keeps the
   windows that start inside the range.
5. **Grouping** (`groupByWorkingDay`): windows grouped by the **working day
   they fall in**, that is the display-zone day on which their working span
   started, never split at midnight (1.2.0): a New York working day seen from
   Paris reads `13:00–01:00` on one line, and a free hour at 00:00 after a
   late block still belongs to that day instead of opening the next one with
   a `00:00–01:00` fragment. A span that started before the range and is
   still running now is attached to today, so "today" keeps what is available
   right now. Excluded weekdays and part-of-day filters applied (morning
   before 12:00, afternoon from 12:00, evening from 18:00; afternoon and
   evening have no end, so a window running past midnight stays whole); "all
   day" when the single window equals the day's single working span, compared
   as instants so it holds in any asker zone.
6. **Listing rules**: days without hours are never listed; days without
   availability are listed only for ranges of 7 days or less; at most
   `listing_cap_days` (10) days with availability, then a "first days shown"
   line. "When is X free?" with no date = the next 5 days with hours.
7. **Point questions** (minute precision; a point in the next few minutes is
   not clipped away by the five-minute rounding): past → "already in the past";
   day without hours → "does not take meetings on …"; outside hours → "outside
   usual hours"; inside a free window → "free from <point> to <window end>",
   the real end even when the working day runs past midnight in the asker's
   zone; free but shorter than a requested duration → "free at … but only
   until …, next window of at least <duration> …"; inside busy → "busy at …,
   next free window …" (the next window must fit a requested duration, which is
   then named, and stays on the asked day).
8. **Slot questions** (1.2.0, `classifySpan` next to `classifyPoint`): one
   verdict per asked moment or span, in the order asked, never the day's other
   windows. A moment gets the point verdicts above. A span ("Monday 12 to 4")
   is *free* when free windows cover it entirely, *busy* when none touches it
   (the next window of the day is named, counted from the span's end when a
   window overlaps its tail), *partly free* otherwise with the free parts
   listed (parts under the noise floor or a requested duration dropped). A span
   already started is judged from now on; one that is over is "already past".
   A slot beyond the horizon is "more than N weeks ahead" on its own line; the
   pipeline answers with the fixed replies only when every slot is past or
   every slot is beyond the horizon. The busy lookup covers the days of the
   slots that need one, in one Cal.com call.

## Worked example

Schedule Mon–Fri 09:00–17:00 Europe/Paris; busy Monday 2026-10-12 10:00–11:00
and 14:00–14:10 (Paris); question "when is X free Monday?" asked on Friday
2026-10-09 by someone in New York. Working Monday = 09:00–17:00 Paris =
03:00–11:00 New York. Free = 09:00–10:00, 11:00–14:00, 14:10–17:00 Paris. The
10-minute busy block only shortens the afternoon window (a free gap under 15
minutes would be dropped by the noise floor). A single day is a `day` request,
rendered on one line in New York time (regenerated with the engine and
renderer, 1.2.0):

```
*Alex's availability Monday Oct 12*, 🇺🇸 New York time: 3:00–4:00 AM, 5:00–8:00 AM, 8:10–11:00 AM
```

## Rendering (`render.ts`)

Deterministic EN/FR text with the zone label on the first line of a listing
and inline in a yes/no answer. The text is Slack mrkdwn, kept as short as the
facts allow (1.2.0):

- the zone label carries the flag of the zone's country (`zoneFlag` in
  `timezone.ts`, from the tzdata `zone.tab` table in `zone-countries.ts`; a
  globe for UTC or a zone the table does not know);
- English times follow the clock of that country as CLDR records it
  (`clockStyle`, through `Intl`): AM/PM in North America, India or Australia,
  24-hour (`14:00`) in Europe; a zone without a country is 24-hour; French is
  always `14h00`;
- a yes/no answer is one sentence in the full form (`4:00 PM to 5:30 PM`);
  everything else uses the compact span (`formatSpan` in `format.ts`):
  `7:00–10:00 AM` when both ends share AM or PM, `10:30 AM–7:00 PM` otherwise,
  `13:00–16:00` on a 24-hour clock, `13h00–16h00` in French;
- a single day is **one line**: the lead, the zone label, then its windows in
  order; a range keeps one line per day; a whole free day is ✅ "all day"; a
  window that runs past midnight stays on the day it starts (`19:00–01:00`);
  there are no part-of-day labels or emoji (the 1.1.0 🌅 ☀️ 🌆 groups were
  withdrawn as noise);
- a slots answer is the lead line and the zone label, then one bullet per
  asked moment (`*Tue Nov 3, 16:00*`) or span (`*Wed Nov 4, 13:00–15:00*`)
  with its verdict: `✅ free until 14:00` / `✅ free` (a span), `⚠️ partly
  free: …`, `❌ busy, next free …` (or `next window of at least <duration>`),
  `⚠️ free only until …; next window of at least …`, and the fixed qualifiers
  `outside <owner>'s usual hours`, `does not take meetings that day`,
  `already past`, `more than N weeks ahead`; French: `✅ disponible jusqu'à`,
  `⚠️ en partie :`, `❌ pas disponible, prochain créneau …`, never a gendered
  "occupé";
- the lead line, the day and slot labels and the times of a yes/no answer are
  bold (`*…*`).

The renderer also returns every time and date token it used. Only the yes/no
sentence goes through the LLM phrasing (`llm.md`), which is accepted only if
it uses no other token; listings and slot verdicts are posted exactly as
rendered. The admin pages render the bold in their reply previews
(`slackText` in `src/admin/html.ts`).
