/**
 * Test: Slack + AI Integration
 *
 * Starts the Slack bot with the AI brain connected.
 * Logs all incoming/outgoing messages to console.
 * Runs in headed browser mode so you can watch everything.
 *
 * Usage: npx ts-node src/test-slack-ai.ts
 */

import { config } from './config';
import { browserManager } from './browser/browser-manager';
import { startSlackBot, stopSlackBot } from './slack/app';
import { AgentBrain } from './ai/agent';
import { ConversationManager } from './ai/conversation';
import { RequestTracker } from './state/request-tracker';
import { ComdataAutomation } from './browser/comdata-automation';
import { ComCheckOrchestrator } from './orchestrator';
import { HealthMonitor } from './monitoring/health';

async function main() {
  console.log('=== Slack + AI Integration Test ===');
  console.log(`Channel: ${config.slack.channelId}`);
  console.log(`Max comcheck amount: $${config.comcheckMaxAmount}`);
  console.log(`Browser headless: ${config.browser.headless}`);
  console.log();

  // Initialize browser (headed mode for observation)
  console.log('Launching browser...');
  await browserManager.initialize();
  console.log('Browser ready.');

  // Initialize state tracking + AI
  const requestTracker = new RequestTracker();
  const conversationManager = new ConversationManager();
  const agent = new AgentBrain(conversationManager);
  console.log('AI agent + request tracker ready.');

  // Initialize orchestrator + health monitor
  const automation = new ComdataAutomation();
  const orchestrator = new ComCheckOrchestrator(automation, requestTracker);
  const healthMonitor = new HealthMonitor(requestTracker, orchestrator);

  // Start Slack bot
  await startSlackBot({ agent, tracker: requestTracker, orchestrator, healthMonitor });
  console.log();
  console.log('Bot is live! Send a message in the Slack channel to test.');
  console.log('Press Ctrl+C to stop.');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await stopSlackBot();
    await browserManager.close();
    conversationManager.close();
    requestTracker.close();
    console.log('Done.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
