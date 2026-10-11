import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth.js';
import { esc, page, table } from '../html.js';
import type { AdminDeps } from '../server.js';

const PAGE_SIZE = 50;

export function registerQueriesRoutes(app: FastifyInstance, deps: AdminDeps): void {
  app.get('/', { preHandler: requireSession }, async (_req, reply) => reply.redirect('/queries'));

  app.get('/queries', { preHandler: requireSession }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const pageNo = Math.min(1_000_000, Math.max(1, Math.floor(Number(q.page ?? '1')) || 1));
    const filter = {
      workspaceId: q.workspace || undefined,
      userId: q.user || undefined,
      entryPoint: q.entry || undefined,
      from: q.from ? `${q.from}T00:00:00.000Z` : undefined,
      to: q.to ? `${q.to}T23:59:59.999Z` : undefined,
      limit: PAGE_SIZE,
      offset: (pageNo - 1) * PAGE_SIZE,
    };
    const { rows, total } = deps.repos.queries.list(filter);
    const workspaces = deps.repos.queries.distinctWorkspaces();
    const users = deps.repos.queries.distinctUsers();
    const opt = (value: string, label: string, selected: string | undefined) => `<option value="${esc(value)}"${value === (selected ?? '') ? ' selected' : ''}>${esc(label)}</option>`;
    const form = `<form method="get" action="/queries" class="panel row">
      <label class="field"><span>Workspace</span><select name="workspace">${opt('', 'all', q.workspace)}${workspaces.map((w) => opt(w.workspace_id, w.workspace_name ?? w.workspace_id, q.workspace)).join('')}</select></label>
      <label class="field"><span>User</span><select name="user">${opt('', 'all', q.user)}${users.map((u) => opt(u.user_id, u.user_name ?? u.user_id, q.user)).join('')}</select></label>
      <label class="field"><span>Entry point</span><select name="entry">${['', 'dm', 'mention', 'slash', 'sandbox', 'cli'].map((e) => opt(e, e || 'all', q.entry)).join('')}</select></label>
      <label class="field"><span>From</span><input type="text" name="from" placeholder="YYYY-MM-DD" value="${esc(q.from ?? '')}"></label>
      <label class="field"><span>To</span><input type="text" name="to" placeholder="YYYY-MM-DD" value="${esc(q.to ?? '')}"></label>
      <div><button type="submit" class="primary">Filter</button></div></form>`;
    const body = table(
      ['When (UTC)', 'Workspace', 'User', 'Via', 'Question', 'Intent', 'Lang / zone', 'ms', 'Cost', ''],
      rows.map((r) => [
        esc(r.received_at?.replace('T', ' ').slice(0, 19)),
        esc(r.workspace_name ?? r.workspace_id ?? ''),
        esc(r.user_name ?? r.user_id),
        esc(r.entry_point),
        esc(r.question.length > 80 ? r.question.slice(0, 80) + '…' : r.question),
        esc(r.intent ?? '') + (r.error ? ` <span class="pill bad">${esc(r.error)}</span>` : ''),
        esc(`${r.language ?? ''} / ${r.timezone_used ?? ''}`),
        esc(r.latency_ms ?? ''),
        r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : '',
        `<a href="/queries/${r.id}">detail</a>`,
      ]),
    );
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const keep = new URLSearchParams({ workspace: q.workspace ?? '', user: q.user ?? '', entry: q.entry ?? '', from: q.from ?? '', to: q.to ?? '' });
    const pager = `<p class="muted">${total} questions · page ${pageNo} of ${pages}${pageNo > 1 ? ` · <a href="/queries?${keep}&page=${pageNo - 1}">previous</a>` : ''}${pageNo < pages ? ` · <a href="/queries?${keep}&page=${pageNo + 1}">next</a>` : ''}</p>`;
    return reply.type('text/html').send(page({ title: 'Queries', botName: deps.config.botName, active: '/queries', authenticated: true, csrfField: req.csrfField, body: `<h1>Queries</h1>${form}${body}${pager}` }));
  });

  app.get('/queries/:id', { preHandler: requireSession }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const r = Number.isInteger(id) ? deps.repos.queries.get(id) : null;
    if (!r) return reply.code(404).type('text/html').send(page({ title: 'Not found', botName: deps.config.botName, authenticated: true, csrfField: req.csrfField, body: '<p>No such query.</p>' }));
    const kv = (k: string, v: unknown) => `<dt>${esc(k)}</dt><dd>${esc(v ?? '')}</dd>`;
    const body = `<h1>Query #${r.id}</h1><p><a href="/queries">← back</a></p>
      <div class="panel"><dl class="kv">${kv('Received (UTC)', r.received_at)}${kv('Workspace', `${r.workspace_name ?? ''} ${r.workspace_id ?? ''}`)}${kv('User', `${r.user_name ?? ''} ${r.user_id}`)}${kv('Entry point', r.entry_point)}${kv('Channel', r.channel_id)}${kv('Intent', r.intent)}${kv('Language / zone', `${r.language ?? ''} / ${r.timezone_used ?? ''}`)}${kv('Latency', r.latency_ms != null ? `${r.latency_ms} ms` : '')}${kv('Tokens', `${r.prompt_tokens ?? 0} in / ${r.completion_tokens ?? 0} out`)}${kv('Cost', r.cost_usd != null ? `$${r.cost_usd.toFixed(6)}` : '')}${kv('Error', r.error)}</dl></div>
      <h2>Question</h2><div class="reply">${esc(r.question)}</div>
      <h2>Interpretation</h2><pre>${esc(r.parsed_json ?? '')}</pre>
      <h2>Answer</h2><div class="reply">${esc(r.answer ?? '')}</div>`;
    return reply.type('text/html').send(page({ title: `Query ${r.id}`, botName: deps.config.botName, active: '/queries', authenticated: true, csrfField: req.csrfField, body }));
  });
}
