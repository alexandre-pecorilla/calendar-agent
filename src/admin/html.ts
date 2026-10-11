/**
 * Minimal server-rendered HTML. Every dynamic value goes through `esc()`;
 * the CSP forbids inline scripts, so pages are plain forms and tables.
 */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PageOptions {
  title: string;
  botName: string;
  active?: string;
  flash?: { kind: 'ok' | 'error'; text: string } | null;
  body: string;
  authenticated: boolean;
  /** Hidden CSRF input for the logout form (authenticated pages). */
  csrfField?: string;
}

const NAV: Array<[string, string]> = [
  ['/queries', 'Queries'],
  ['/settings', 'Settings'],
  ['/workspaces', 'Workspaces'],
  ['/sandbox', 'Sandbox'],
];

export function page(o: PageOptions): string {
  const nav = o.authenticated
    ? `<nav>${NAV.map(([href, label]) => `<a href="${href}"${o.active === href ? ' class="active"' : ''}>${label}</a>`).join('')}<form method="post" action="/logout" class="inline">${o.csrfField ?? ''}<button type="submit" class="link">Log out</button></form></nav>`
    : '';
  const flash = o.flash ? `<div class="flash ${o.flash.kind}">${esc(o.flash.text)}</div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · ${esc(o.botName)}</title>
<link rel="stylesheet" href="/static/admin.css">
</head>
<body>
<header><span class="brand">${esc(o.botName)}</span>${nav}</header>
<main>${flash}${o.body}</main>
<footer>calendar-agent · free/busy only · never books anything</footer>
</body>
</html>`;
}

export function table(headers: string[], rows: string[][]): string {
  const h = headers.map((x) => `<th>${esc(x)}</th>`).join('');
  const b = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${h}</tr></thead><tbody>${b || `<tr><td colspan="${headers.length}" class="muted">nothing yet</td></tr>`}</tbody></table>`;
}

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

export function field(label: string, input: string, help?: string): string {
  return `<label class="field"><span>${esc(label)}</span>${input}${help ? `<small>${esc(help)}</small>` : ''}</label>`;
}
