/**
 * The bot's Slack permissions: the structural least-privilege list (scope §9).
 * `tests/repo/slack-scopes.test.ts` asserts the manifest requests exactly these
 * and no user scopes.
 */
export const BOT_SCOPES = [
  'app_mentions:read', // app_mention events
  'chat:write', // replies, ephemeral messages
  'commands', // the slash command
  'im:history', // message.im events (DMs to the bot)
  'im:read', // DM channel metadata
  'im:write', // open a DM when replying
  'users:read', // users.info: asker timezone and locale
] as const;

export const BOT_EVENTS = ['app_mention', 'message.im'] as const;
