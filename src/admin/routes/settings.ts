import type { FastifyInstance } from 'fastify';
import { NUMERIC_DEFAULTS, type NumericSettingKey } from '../../db/repos/settings.js';
import { SESSION_COOKIE, requireCsrf, requireSession } from '../auth.js';
import { esc, field, page } from '../html.js';
import type { AdminDeps } from '../server.js';

const NUMERIC_LABELS: Record<NumericSettingKey, [string, string]> = {
  horizon_days: ['Horizon (days)', 'How far ahead questions may look (28 = 4 weeks)'],
  noise_floor_minutes: ['Noise floor (minutes)', 'Gaps shorter than this are not listed'],
  listing_cap_days: ['Listing cap (days)', 'Maximum days with availability in one answer'],
  rate_user_per_minute: ['Questions per user per minute', ''],
  rate_workspace_per_minute: ['Questions per workspace per minute', ''],
  rate_global_per_minute: ['Questions per minute, all workspaces', 'Keep under Cal.com\'s 120 requests/minute'],
  daily_budget: ['Daily budget (questions)', 'After this, the bot answers "over capacity" until midnight UTC'],
};

export function registerSettingsRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const render = (req: { csrfField: string }, flash: { kind: 'ok' | 'error'; text: string } | null) => {
    const s = deps.repos.settings;
    const c = deps.config;
    const masked = (key: 'calcom_api_key' | 'deepseek_api_key') => s.getSecret(key)?.masked() ?? (s.isUnreadable(key) ? 'unreadable (encrypted with a previous master key): paste it again' : '(not set)');
    const csrf = req.csrfField;
    const numeric = (Object.keys(NUMERIC_DEFAULTS) as NumericSettingKey[])
      .map((k) => field(NUMERIC_LABELS[k][0], `<input type="number" name="${k}" min="0" value="${s.getNumber(k)}">`, NUMERIC_LABELS[k][1] || `default ${NUMERIC_DEFAULTS[k]}`))
      .join('');
    const body = `<h1>Settings</h1>
      <div class="panel"><h2>Identity (from .env, read-only)</h2><dl class="kv">
        <dt>Owner</dt><dd>${esc(c.ownerName)}</dd><dt>Aliases</dt><dd>${esc(c.ownerAliases.join(', ') || '—')}</dd>
        <dt>Bot name</dt><dd>${esc(c.botName)} · @${esc(c.botName)} · ${esc(c.slashCommand)}</dd>
        <dt>Install mode</dt><dd>${esc(c.installMode)}</dd></dl></div>
      <form method="post" action="/settings" class="panel">${csrf}<h2>Provider keys (stored encrypted)</h2>
        ${field('Cal.com API key', `<input type="password" name="calcom_api_key" placeholder="leave empty to keep ${esc(masked('calcom_api_key'))}" autocomplete="new-password">`, `current: ${masked('calcom_api_key')}`)}
        ${field('DeepSeek API key', `<input type="password" name="deepseek_api_key" placeholder="leave empty to keep ${esc(masked('deepseek_api_key'))}" autocomplete="new-password">`, `current: ${masked('deepseek_api_key')}`)}
        <h2>Behaviour</h2>${numeric}
        <button type="submit" class="primary">Save</button></form>
      <div class="row">
        <form method="post" action="/settings/test/calcom" class="panel">${csrf}<h2>Cal.com</h2><p class="muted">Calls /v2/me, lists the selected calendars and the schedule.</p><button type="submit" class="secondary">Test connection</button></form>
        <form method="post" action="/settings/test/deepseek" class="panel">${csrf}<h2>DeepSeek</h2><p class="muted">One tiny completion.</p><button type="submit" class="secondary">Test connection</button></form>
      </div>
      <form method="post" action="/settings/logout-all" class="panel">${csrf}<h2>Sessions</h2><p class="muted">Ends every admin session, including this one. Sessions also end 7 days after their last use, 30 days after login, and when ADMIN_PASSWORD changes.</p><button type="submit" class="secondary">Log out everywhere</button></form>`;
    return page({ title: 'Settings', botName: c.botName, active: '/settings', authenticated: true, csrfField: req.csrfField, flash, body });
  };

  app.get('/settings', { preHandler: requireSession }, async (req, reply) => reply.type('text/html').send(render(req, null)));

  app.post('/settings', { preHandler: [requireSession, requireCsrf] }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const s = deps.repos.settings;
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    if (str('calcom_api_key')) s.setSecret('calcom_api_key', str('calcom_api_key'));
    if (str('deepseek_api_key')) s.setSecret('deepseek_api_key', str('deepseek_api_key'));
    const bad: string[] = [];
    for (const k of Object.keys(NUMERIC_DEFAULTS) as NumericSettingKey[]) {
      const v = str(k);
      if (v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100000) bad.push(k);
      else s.set(k, String(Math.round(n)));
    }
    deps.services.calcomCache.invalidate();
    deps.log.info({ changed: Object.keys(body).filter((k) => k !== '_csrf' && str(k)) }, 'settings saved');
    return reply.type('text/html').send(render(req, bad.length ? { kind: 'error', text: `Invalid values ignored: ${bad.join(', ')}` } : { kind: 'ok', text: 'Saved.' }));
  });

  app.post('/settings/logout-all', { preHandler: [requireSession, requireCsrf] }, async (_req, reply) => {
    const n = deps.repos.sessions.deleteAll();
    deps.log.info({ sessionsCleared: n }, 'admin logged out everywhere');
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login');
  });

  app.post('/settings/test/calcom', { preHandler: [requireSession, requireCsrf] }, async (req, reply) => {
    try {
      const me = await deps.services.calcom.me();
      const cals = await deps.services.calcom.calendars();
      const sched = await deps.services.calcom.defaultSchedule();
      const selected = cals.filter((c) => c.isSelected).map((c) => c.externalId).join(', ');
      return reply.type('text/html').send(render(req, { kind: 'ok', text: `Cal.com OK: ${me.username ?? '?'}; ${cals.filter((c) => c.isSelected).length} selected calendar(s): ${selected}; schedule ${sched ? `${sched.timeZone}, ${sched.availability.map((a) => `${a.startTime}-${a.endTime}`).join(' / ')}` : 'none'}.` }));
    } catch (err) {
      return reply.type('text/html').send(render(req, { kind: 'error', text: `Cal.com failed: ${(err as Error).message}` }));
    }
  });

  app.post('/settings/test/deepseek', { preHandler: [requireSession, requireCsrf] }, async (req, reply) => {
    try {
      const r = await deps.services.deepseek.complete({ system: 'Reply with the single word OK.', user: 'Ready?', json: false, maxTokens: 200, effort: 'off' });
      return reply.type('text/html').send(render(req, { kind: 'ok', text: `DeepSeek OK: "${r.content.slice(0, 20)}" in ${r.latencyMs} ms, ${r.usage.promptTokens + r.usage.completionTokens} tokens, $${r.usage.costUsd.toFixed(6)}.` }));
    } catch (err) {
      return reply.type('text/html').send(render(req, { kind: 'error', text: `DeepSeek failed: ${(err as Error).message}` }));
    }
  });
}
