# Asking the bot when someone is available

This bot answers one question: **when is its owner available?** It reads the
owner's calendar free/busy state and tells you the free windows. It never shows
what is on the calendar and it never books anything: when you have found a
time, send the owner an invite as you normally would.

The bot's name is the owner's first name followed by `-calendar-agent`, for
example `alex-calendar-agent`. The slash command is the same name.

## Three ways to ask

| Where | How | Who sees the answer |
| --- | --- | --- |
| Direct message | Open a DM with the bot and type your question | you |
| In a channel | `@<bot-name> is <name> free Monday at 4 pm?` (the bot must be a member of the channel) | the channel, in a thread under your message |
| Anywhere | `/<bot-name> <your question>` | only you (an ephemeral message) |

You don't need to say the owner's name: "free Monday at 4?", "are you free
tomorrow?" and "is <name> available Monday?" all mean the owner.

## What you can ask

- A moment: "Is <name> available Monday at 4 pm?", "tomorrow at 10?"
- Several times at once: "Tuesday at 4 or Wednesday at 11:30?", "Monday 12 to 4, Thursday 3 pm?" gives one line per time, yes or no, and nothing else. Paste the times a counterpart proposed and name the zone they are in.
- A day: "When is <name> free on Tuesday?", "Thursday morning?" (morning is before noon, afternoon from noon, evening from 6 pm)
- A range: "<name>'s availability next week except Wednesday?", "any time in the next two weeks?"
- Nothing specific: "When is <name> free?" gives the next five working days.
- With a duration: "Do you have an hour on Tuesday?" lists only windows of at least an hour.
- In another timezone: "Monday at 9 am Paris time."

Ask in English or in French; the bot answers in your language.

## What the answer looks like

```
Yes, Alex is free Monday Oct 12 from *4:00 PM to 5:30 PM*, 🇺🇸 New York time.

*Alex's availability*, 🇫🇷 Paris time:
• *Tue Nov 3, 16:00*: ❌ busy, next free 17:30–18:00
• *Wed Nov 4, 11:30*: outside Alex's usual hours
• *Wed Nov 4, 13:30*: ✅ free until 14:00
• *Wed Nov 4, 13:00–15:00*: ⚠️ partly free: 13:00–14:00, 14:30–15:00

*Alex's availability Tuesday Oct 13*, 🇺🇸 New York time: 7:00–9:00 AM, 1:00–5:00 PM, 6:00–7:00 PM

*Alex's availability from Mon Oct 12 to Fri Oct 16 (except Wednesday)*, 🇺🇸 New York time:
• *Mon Oct 12*: 9:00–11:30 AM, 2:00–5:00 PM
• *Tue Oct 13*: 10:00 AM–12:00 PM
• *Thu Oct 15*: ✅ all day, 9:00 AM–6:00 PM
• *Fri Oct 16*: no availability
```

Slack shows `*…*` in bold. A single day is one line, several days one line
per day. The owner's working day is listed on the day it starts in your
zone, even when it runs past midnight ("19:00–01:00").

Times are shown in **your** timezone, the one set in your Slack profile, and
the timezone is always written in the answer, with the flag of its country.
The clock follows that country: AM/PM in North America, 24-hour in Europe
("14:00"). In French it is always "14h00". If your profile timezone is wrong
or you are travelling, name the zone you want: "in London time".

## What the bot will not do

- Say why the owner is busy, or what the meeting is. It only knows free or busy.
- Book, hold, move or cancel anything. Send an invite yourself.
- Look further than four weeks ahead, or into the past.
- Answer about anyone else's calendar, or about yours.

If you ask something it cannot do, it says so in one line. Type `help` to see
examples again.

## Good to know

- Free windows follow the owner's usual hours. Outside them the bot says
  "outside <name>'s usual hours" rather than "busy".
- A whole free day is shown as "all day".
- If a question is unclear, the bot asks you to rephrase with a day or a
  time; if it is not an availability question, it says what it can do.
- The bot answers within a few seconds. Many questions in a minute from the
  same person are rate-limited.
