import { describe, expect, it } from 'vitest';
import { BOT_EVENTS, BOT_SCOPES } from '../../src/slack/scopes.js';

/**
 * Structural guard: the bot requests exactly the least-privilege scopes of the
 * scope document (§9) and subscribes to the two events it handles. Any
 * addition must change this test on purpose.
 */
const ALLOWED_SCOPES = ['app_mentions:read', 'chat:write', 'commands', 'im:history', 'im:read', 'im:write', 'users:read'];

describe('slack scopes', () => {
  it('requests exactly the allowlisted bot scopes, no user scopes, no history beyond DMs', () => {
    expect([...BOT_SCOPES].sort()).toEqual([...ALLOWED_SCOPES].sort());
    for (const s of BOT_SCOPES) {
      expect(s, `${s} is a user scope`).not.toMatch(/^(search|users:read\.email|channels|groups|mpim|files|admin|team|chat:write\.customize)/);
    }
    expect([...BOT_EVENTS]).toEqual(['app_mention', 'message.im']);
  });
});
