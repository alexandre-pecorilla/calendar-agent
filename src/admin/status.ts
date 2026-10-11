/** Runtime status shared between the Slack module and the admin pages. */
export interface RuntimeStatus {
  slackConnected: boolean;
  slackLastEventAt: string | null;
  /** When the socket was last lost (reconnecting since then while `slackConnected` is false). */
  slackDisconnectedAt: string | null;
  slackBotUserId: string | null;
  startedAt: string;
}

export function createStatus(): RuntimeStatus {
  return { slackConnected: false, slackLastEventAt: null, slackDisconnectedAt: null, slackBotUserId: null, startedAt: new Date().toISOString() };
}
