import { DateTime } from 'luxon';
import type { FastifyInstance } from 'fastify';
import { isValidZone } from '../../availability/timezone.js';
import { requireCsrf, requireSession } from '../auth.js';
import { esc, field, page } from '../html.js';
import type { AdminDeps } from '../server.js';

const ZONES = ['America/New_York', 'Europe/Paris', 'Europe/London', 'America/Los_Angeles', 'America/Chicago', 'Asia/Tokyo', 'UTC'];

export function registerSandboxRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const render = (req: { csrfField: string }, state: { question: string; tz: string; lang: string; now: string }, result: Awaited<ReturnType<typeof deps.services.pipeline.ask>> | null, flash: { kind: 'ok' | 'error'; text: string } | null) => {
    const csrf = req.csrfField;
    const zoneOpts = [`<option value=""${state.tz === '' ? ' selected' : ''}>(none: the owner's zone, as when Slack has no timezone)</option>`, ...[...new Set([...ZONES, state.tz].filter(Boolean))].map((z) => `<option value="${esc(z)}"${z === state.tz ? ' selected' : ''}>${esc(z)}</option>`)].join('');
    const form = `<form method="post" action="/sandbox" class="panel">${csrf}
      ${field('Question', `<textarea name="question" required>${esc(state.question)}</textarea>`, 'Exactly what someone would type in Slack')}
      <div class="row">
        ${field('Asker timezone', `<select name="tz">${zoneOpts}</select>`)}
        ${field('Other IANA zone', `<input type="text" name="tz_custom" placeholder="e.g. Australia/Sydney">`, 'overrides the list when filled')}
        ${field('Asker language', `<select name="lang"><option value="en"${state.lang === 'en' ? ' selected' : ''}>English</option><option value="fr"${state.lang === 'fr' ? ' selected' : ''}>Français</option></select>`)}
        ${field('Pretend now is', `<input type="text" name="now" value="${esc(state.now)}" placeholder="2026-10-09T12:00">`, 'local time in the chosen zone (UTC if none); empty = real now')}
      </div><button type="submit" class="primary">Ask</button></form>`;
    let out = '';
    if (result) {
      const d = result.debug;
      out = `<h2>Reply</h2><div class="reply">${esc(result.text)}</div>
        <h2>Debug</h2><div class="panel"><dl class="kv">
          <dt>Intent</dt><dd>${esc(result.intent)}</dd>
          <dt>Language</dt><dd>${esc(d.language)}</dd>
          <dt>Zone</dt><dd>${esc(d.zone)} (${esc(d.zoneSource)}) · label "${esc(d.zoneLabel)}"</dd>
          <dt>Busy intervals</dt><dd>${esc(d.busyCount ?? '—')}</dd>
          <dt>Free windows</dt><dd>${d.windows.length ? d.windows.map((w) => esc(w)).join('<br>') : '—'}</dd>
          <dt>Phrased</dt><dd>${d.phrased ? '<span class="pill ok">model text accepted</span>' : '<span class="pill">draft sent</span>'} · verification ${esc(d.verification)}</dd>
          <dt>Latency</dt><dd>${esc(d.latencyMs)} ms</dd>
          <dt>Tokens</dt><dd>${esc(d.promptTokens)} in / ${esc(d.completionTokens)} out (${esc(d.reasoningTokens)} thinking)</dd>
          <dt>Cost</dt><dd>$${esc(d.costUsd.toFixed(6))}</dd>
          <dt>Error</dt><dd>${esc(d.error ?? '—')}</dd>
          <dt>Query id</dt><dd><a href="/queries/${result.queryId}">#${result.queryId}</a></dd></dl>
        <h2>Interpretation (call 1)</h2><pre>${esc(JSON.stringify(d.parsed, null, 2) ?? d.parseRaw ?? '')}</pre>
        <h2>Deterministic draft (input of call 2)</h2><pre>${esc(d.draft ?? '—')}</pre></div>`;
    }
    const recent = deps.repos.queries.list({ entryPoint: 'sandbox', limit: 10 }).rows;
    const history = recent.length
      ? `<h2>Recent sandbox questions</h2>${recent.map((r) => `<p><a href="/queries/${r.id}">#${r.id}</a> <span class="muted">${esc(r.received_at?.slice(0, 16).replace('T', ' '))}</span> ${esc(r.question)} → <span class="muted">${esc(r.intent ?? '')}</span></p>`).join('')}`
      : '';
    return page({ title: 'Sandbox', botName: deps.config.botName, active: '/sandbox', authenticated: true, csrfField: req.csrfField, flash, body: `<h1>Sandbox</h1><p class="muted">Runs the exact pipeline Slack uses, without Slack. Questions are logged with entry point "sandbox".</p>${form}${out}${history}` });
  };

  const defaults = { question: '', tz: 'America/New_York', lang: 'en', now: '' };

  app.get('/sandbox', { preHandler: requireSession }, async (req, reply) => reply.type('text/html').send(render(req, defaults, null, null)));

  app.post('/sandbox', { preHandler: [requireSession, requireCsrf] }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
    const tz = str('tz_custom') || str('tz');
    const state = { question: str('question').slice(0, 2000), tz, lang: str('lang') === 'fr' ? 'fr' : 'en', now: str('now') };
    if (tz && !isValidZone(tz)) return reply.type('text/html').send(render(req, state, null, { kind: 'error', text: `Unknown timezone "${tz}".` }));
    let now: DateTime | undefined;
    if (state.now) {
      // "Pretend now" is local time in the chosen zone, or UTC when none is chosen.
      now = DateTime.fromISO(state.now, { zone: tz || 'UTC' });
      if (!now.isValid) return reply.type('text/html').send(render(req, state, null, { kind: 'error', text: 'Invalid "pretend now" value; use YYYY-MM-DDTHH:MM.' }));
    }
    const result = await deps.services.pipeline.ask({ userId: 'admin', userName: 'admin (sandbox)', entryPoint: 'sandbox', askerTz: tz || null, askerLocale: state.lang === 'fr' ? 'fr-FR' : 'en-US', now }, state.question);
    return reply.type('text/html').send(render(req, state, result, null));
  });
}
