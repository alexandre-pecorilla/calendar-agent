import type { FastifyInstance } from 'fastify';
import { requireCsrf, requireSession } from '../auth.js';
import { esc, page, table } from '../html.js';
import type { AdminDeps } from '../server.js';
import { installUrl } from '../../slack/install-routes.js';

export function registerWorkspacesRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const render = async (req: { csrfField: string }, flash: { kind: 'ok' | 'error'; text: string } | null) => {
    const csrf = req.csrfField;
    const installs = deps.repos.installations.list();
    const stale = deps.repos.installations.unreadable();
    const st = deps.status;
    let calcomLine: string;
    try {
      const cals = (await deps.services.calcomCache.calendars()).filter((c) => c.isSelected);
      const s = await deps.services.calcomCache.defaultSchedule();
      calcomLine = `<span class="pill ok">reachable</span> ${cals.length} calendar(s) checked: ${esc(cals.map((c) => c.externalId).join(', '))} · schedule ${esc(s ? `${s.timeZone}, ${s.availability.map((a) => `${a.days.length} days ${a.startTime}-${a.endTime}`).join(' / ')}` : 'none')}`;
    } catch (err) {
      calcomLine = `<span class="pill bad">unreachable</span> ${esc((err as Error).message)}`;
    }
    const add =
      deps.config.installMode === 'multi'
        ? `<p><a class="primary" href="${esc(installUrl(deps.config) ?? '/slack/install')}">Add to Slack</a> <span class="muted">opens Slack's authorisation page for another workspace on the HTTPS address (log in there if asked); use a desktop browser.</span></p>`
        : `<p class="muted">Single-workspace mode: the bot token in .env is the only installation and is re-seeded at every start; to remove it, delete SLACK_BOT_TOKEN from .env and restart. Switch INSTALL_MODE to multi for the OAuth installer.</p>`;
    const body = `<h1>Workspaces</h1>
      <div class="panel"><dl class="kv">
        <dt>Socket Mode</dt><dd>${st.slackConnected ? '<span class="pill ok">connected</span>' : `<span class="pill bad">not connected</span>${st.slackDisconnectedAt ? ` · reconnecting since ${esc(st.slackDisconnectedAt)}` : ''}`} ${st.slackLastEventAt ? `· last event ${esc(st.slackLastEventAt)}` : ''}</dd>
        <dt>Cal.com</dt><dd>${calcomLine}</dd>
        <dt>Started</dt><dd>${esc(st.startedAt)}</dd></dl></div>
      ${add}
      ${table(['Workspace', 'Team id', 'Bot user', 'Scopes', 'Installed', ''], [
        ...installs.map((i) => [esc(i.teamName ?? ''), esc(i.teamId), esc(i.botUserId ?? ''), esc(i.scopes.join(' ')), esc(i.installedAt.slice(0, 19).replace('T', ' ')) + (i.installedBy === 'env' ? ' <span class="pill">from .env</span>' : ''), i.installedBy === 'env' && deps.config.SLACK_BOT_TOKEN ? '<span class="muted">remove SLACK_BOT_TOKEN from .env</span>' : `<form method="post" action="/workspaces/${esc(i.teamId)}/remove" class="inline">${csrf}<button type="submit" class="secondary">Remove</button></form>`]),
        ...stale.map((w) => [esc(w.teamName ?? ''), esc(w.teamId), '', '', '<span class="pill bad">unreadable</span> token encrypted with a previous master key: re-install it (Add to Slack) or remove it', `<form method="post" action="/workspaces/${esc(w.teamId)}/remove" class="inline">${csrf}<button type="submit" class="secondary">Remove</button></form>`]),
      ])}`;
    return page({ title: 'Workspaces', botName: deps.config.botName, active: '/workspaces', authenticated: true, csrfField: req.csrfField, flash, body });
  };

  app.get('/workspaces', { preHandler: requireSession }, async (req, reply) => reply.type('text/html').send(await render(req, null)));

  app.post('/workspaces/:teamId/remove', { preHandler: [requireSession, requireCsrf] }, async (req, reply) => {
    const teamId = (req.params as { teamId: string }).teamId;
    const removed = deps.repos.installations.remove(teamId);
    deps.log.info({ teamId, removed }, 'workspace removed from admin');
    return reply.type('text/html').send(await render(req, removed ? { kind: 'ok', text: `Workspace ${teamId} removed. Also remove the app from that workspace's settings in Slack.` } : { kind: 'error', text: 'No such active workspace.' }));
  });
}
