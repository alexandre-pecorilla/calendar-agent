# Admin and sandbox

A small server-rendered web application on the same port as the health
endpoint (`src/admin/`). No frontend framework, no inline scripts: plain forms
and tables, one stylesheet, a Content-Security-Policy of `default-src 'self'`.

## Access

- `http://<host>:<port>` on the addresses listed in `APP_BIND_ADDRESSES`
  (loopback by default; add the Tailscale IP to reach it over the tailnet;
  never a public interface).
- In `multi` mode the same server is also reachable through the HTTPS
  Tailscale Serve mapping that Slack's OAuth redirect needs.

## Authentication (`auth.ts`)

- One password, `ADMIN_PASSWORD` from `.env`, hashed with scrypt (random salt)
  at boot; the plaintext is not kept. Candidates are compared in constant time.
- Sessions: opaque 32-byte token in the `ca_session` cookie (`HttpOnly`,
  `SameSite=Lax`, `Secure` when the request arrived over HTTPS, 30-day
  expiry, 7-day idle timeout), SHA-256 of the token stored in `sessions`.
  Every session ends when `ADMIN_PASSWORD` changes (a fingerprint is compared
  at boot) or with "Log out everywhere" in Settings.
- Progressive delay instead of a lockout (R4-1): after n consecutive failures
  the next attempt is accepted min(2^(n-1), 60) seconds after the last
  failure (1 s, 2 s, 4 s … 60 s); attempts during the delay get a 429 page
  and are not counted; a success clears the count. Global by design: one
  owner, and behind a proxy no client key can be trusted. Attempts are stored
  in the database, so a restart does not reset them. The login route is
  additionally rate-limited (20 per minute per connecting socket address,
  which behind Docker's port publishing is the bridge, so effectively global).
  The login log records the socket address and the forwarded header
  separately (R4-2).
- CSRF: every state-changing form carries the session's CSRF token in a hidden
  field; the server compares it in constant time and answers 403 otherwise.
- Unauthenticated browser requests are redirected to `/login`; non-GET
  requests get 401. `/health` (liveness, Socket Mode state, workspace count;
  the bot name and install mode only with a session) and `/static/*` are
  public (dotfiles excluded). Logout requires a session and the CSRF token.
- Headers on every response: CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, `Permissions-Policy`, and
  `Strict-Transport-Security` when the request arrived over HTTPS.

## Pages

| Page | What it does |
| --- | --- |
| Queries | Every question, filterable by workspace, user, entry point and date range; a detail page with the interpretation and the answer. All content HTML-escaped. |
| Settings | Identity block (read-only, from `.env`); Cal.com and DeepSeek keys (stored encrypted, shown masked, empty field keeps the current value); horizon, noise floor, listing cap, rate limits, daily budget; "Test connection" buttons for both providers. Saving invalidates the Cal.com cache. |
| Workspaces | Socket Mode state, Cal.com reachability with the checked calendars and schedule, the connected workspaces, "Add to Slack" (multi mode), removal. |
| Sandbox | The exact pipeline Slack uses, without Slack: question, asker timezone (list, any IANA zone, or none to reproduce a Slack profile without timezone), asker language, optional "pretend now is" (local time in the chosen zone). Shows the reply as Slack would and a debug panel: intent, zone and source, busy-interval count, free windows, phrased-or-draft with the verification reason, latency, tokens (thinking included), cost, the interpretation JSON and the deterministic draft. Logged with entry point `sandbox`, user `admin`; limits do not apply. |

## What the admin never shows

Secrets in clear (masked only), event details (none exist), container logs
(no content in them). Removing a workspace here only forgets its token; the app
must also be removed in that workspace's Slack settings.
