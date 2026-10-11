# Review rounds

Independent review rounds after the build (action plan §10). Each round is
run by a fresh reviewer with no access to earlier reports until its own is
written; findings carry a severity, a location, a reproduction and a fix; fix
commits are referenced from the report and the full gate is rerun after each.

- `R1.md` — correctness (availability math, timezones, date phrases, formats, fixed replies, error paths).
- `R2.md` — integration (Slack modes and install flow, admin, sandbox parity, Docker, Makefile, boot).
- `R3.md` — documentation and operability (every statement checked against the code and the running container).
- `R4.md` — security (threat model walk-through, the fifteen controls, admin checklist, secrets, container, dependencies, injection rerun).
