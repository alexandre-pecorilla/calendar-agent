import type { AppConfig } from '../config/env.js';
import { BOT_EVENTS, BOT_SCOPES } from './scopes.js';

/**
 * The Slack app manifest, rendered from the configuration (scope §20): one
 * name for the app, the bot handle and the slash command; Socket Mode; the
 * Messages tab so people can DM the bot; the redirect URL in multi mode.
 */
export function renderManifest(config: Pick<AppConfig, 'ownerName' | 'botName' | 'slashCommand' | 'installMode' | 'PUBLIC_BASE_URL'>): Record<string, unknown> {
  const name = config.botName;
  const owner = config.ownerName;
  return {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name,
      description: `Ask when ${owner} is available. Free/busy only, never books anything.`,
      background_color: '#1f2937',
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: true },
      slash_commands: [
        {
          command: config.slashCommand,
          description: `Ask when ${owner} is available`,
          usage_hint: `is ${owner} free Monday at 4pm?`,
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      ...(config.installMode === 'multi' && config.PUBLIC_BASE_URL ? { redirect_urls: [`${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/slack/oauth_redirect`] } : {}),
      scopes: { bot: [...BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: { bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
