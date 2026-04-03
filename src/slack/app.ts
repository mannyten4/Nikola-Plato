/**
 * Slack Bolt App — Socket Mode initialization
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://api.slack.com/apps → Create New App → From scratch
 * 2. Name it "Nikola" (or whatever the persona should be called)
 *
 * 3. OAuth & Permissions → Bot Token Scopes:
 *    - chat:write          (send messages)
 *    - app_mentions:read   (hear @mentions)
 *    - channels:history    (read channel messages)
 *    - channels:read       (list channels)
 *    - groups:history      (private channel messages)
 *    - im:history          (DM history)
 *    - im:read             (DM access)
 *    - im:write            (send DMs)
 *    - reactions:write     (add emoji reactions)
 *    - users:read          (get user display names)
 *
 * 4. Socket Mode → Enable → Generate app-level token (xapp-...)
 *    - Token name: "socket-mode"
 *    - Scope: connections:write
 *
 * 5. Event Subscriptions → Enable → Subscribe to bot events:
 *    - message.channels
 *    - message.im
 *    - app_mention
 *
 * 6. App Home → Show bot as online
 *
 * 7. Install to Workspace → Copy Bot User OAuth Token (xoxb-...)
 *
 * 8. Set the bot's display name and avatar to match the "Nikola" persona
 *
 * 9. Add to .env:
 *    SLACK_BOT_TOKEN=xoxb-...
 *    SLACK_APP_TOKEN=xapp-...
 *    SLACK_SIGNING_SECRET=...
 *    SLACK_CHANNEL_ID=C0XXXXXXX
 */

import { App } from '@slack/bolt';
import { config } from '../config';
import { AgentBrain } from '../ai/agent';
import { RequestTracker } from '../state/request-tracker';
import { ComCheckOrchestrator } from '../orchestrator';
import { HealthMonitor } from '../monitoring/health';
import { registerMessageHandler } from './handlers/message';
import { registerEventHandlers } from './handlers/events';
import { registerCommandHandlers } from './handlers/commands';
import { createLogger } from '../utils/logger';

const logger = createLogger('slack');

let app: App;

export interface SlackBotDeps {
  agent: AgentBrain;
  tracker: RequestTracker;
  orchestrator: ComCheckOrchestrator;
  healthMonitor: HealthMonitor;
}

export function getSlackApp(deps: SlackBotDeps): App {
  if (!app) {
    app = new App({
      token: config.slack.botToken,
      appToken: config.slack.appToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
    });

    // Register all handlers with dependencies
    registerMessageHandler(app, deps.agent, deps.tracker, deps.orchestrator, deps.healthMonitor);
    registerEventHandlers(app, deps.agent, deps.tracker);
    registerCommandHandlers(app, deps.healthMonitor);
  }
  return app;
}

export async function startSlackBot(deps: SlackBotDeps): Promise<void> {
  const slackApp = getSlackApp(deps);
  await slackApp.start();
  logger.info('Slack bot is running (Socket Mode)');
}

export async function stopSlackBot(): Promise<void> {
  if (app) {
    await app.stop();
    console.log('Slack bot stopped');
  }
}
