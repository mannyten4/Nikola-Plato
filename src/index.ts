import { WebClient } from '@slack/web-api';
import { config } from './config';
import { browserManager } from './browser/browser-manager';
import { getSlackApp, startSlackBot, stopSlackBot } from './slack/app';
import { AgentBrain } from './ai/agent';
import { ConversationManager } from './ai/conversation';
import { RequestTracker } from './state/request-tracker';
import { ComdataAutomation } from './browser/comdata-automation';
import { ComCheckOrchestrator } from './orchestrator';
import { HealthMonitor } from './monitoring/health';
import { scheduleDailyReport } from './monitoring/daily-report';
import { Watchdog } from './process/watchdog';
import { createLogger } from './utils/logger';

const logger = createLogger('app');

let healthCheckInterval: NodeJS.Timeout | null = null;
let dailyReportTimeout: NodeJS.Timeout | null = null;
let conversationManager: ConversationManager | null = null;
let requestTracker: RequestTracker | null = null;
let healthMonitor: HealthMonitor | null = null;
let watchdog: Watchdog | null = null;
let orchestrator: ComCheckOrchestrator | null = null;
let slackClient: WebClient | null = null;
let isShuttingDown = false;

async function postSlackNotification(text: string): Promise<void> {
  if (!slackClient) return;
  const channel = config.logChannelId || config.slack.channelId;
  try {
    await slackClient.chat.postMessage({ channel, text });
  } catch {
    // Best effort — don't crash on notification failure
  }
}

async function main() {
  logger.info('browser-ai starting...');
  logger.info(`Target URL: ${config.comdata.url}`);
  logger.info(`Headless: ${config.browser.headless}`);
  logger.info(`Mock browser: ${config.mockBrowser}`);
  logger.info(`Slack channel: ${config.slack.channelId}`);

  try {
    // Initialize browser
    await browserManager.initialize();
    logger.info('Browser launched successfully.');

    // Initialize state tracking
    requestTracker = new RequestTracker();
    logger.info('Request tracker initialized.');

    // Initialize browser automation + orchestrator
    const automation = new ComdataAutomation();
    orchestrator = new ComCheckOrchestrator(automation, requestTracker);
    logger.info('Orchestrator initialized.');

    // Initialize health monitor
    healthMonitor = new HealthMonitor(requestTracker, orchestrator);
    healthMonitor.start();
    logger.info('Health monitor started.');

    // Initialize AI conversation engine
    conversationManager = new ConversationManager();
    const agent = new AgentBrain(conversationManager, requestTracker);
    logger.info('AI agent initialized.');

    // Start Slack bot with all dependencies
    const deps = { agent, tracker: requestTracker, orchestrator, healthMonitor };
    const slackApp = getSlackApp(deps);
    slackClient = slackApp.client;
    automation.setSlackClient(slackApp.client);
    await startSlackBot(deps);

    // Start watchdog
    watchdog = new Watchdog(slackApp.client, requestTracker);
    watchdog.start();
    logger.info('Watchdog started.');

    // Schedule daily report at 9 AM
    dailyReportTimeout = scheduleDailyReport(slackApp.client, requestTracker);
    logger.info('Daily report scheduler initialized.');

    // Health check every 60 seconds
    healthCheckInterval = setInterval(async () => {
      const health = await healthMonitor!.getHealth();
      logger.debug(`Health: browser=${health.browserStatus}, queue=${health.queueDepth}, uptime=${health.uptimeFormatted}`);
    }, 60_000);

    // Cleanup every hour: expired conversations + stuck requests
    setInterval(() => {
      conversationManager?.cleanupExpired();
      requestTracker?.cleanup();
    }, 60 * 60 * 1000);

    // Startup notification
    await postSlackNotification('Browser AI is online 🟢');

    logger.info('browser-ai is fully operational.');
  } catch (error) {
    logger.error('Startup error', error);
    await shutdown(1);
  }
}

async function shutdown(exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Shutting down...');

  // Shutdown notification
  await postSlackNotification('Browser AI going offline 🔴');

  // Stop watchdog
  if (watchdog) {
    watchdog.stop();
  }

  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }

  if (dailyReportTimeout) {
    clearTimeout(dailyReportTimeout);
    dailyReportTimeout = null;
  }

  if (healthMonitor) {
    healthMonitor.stop();
  }

  // Wait for in-progress comcheck to finish (up to 60 seconds)
  if (orchestrator) {
    const status = orchestrator.getQueueStatus();
    if (status.isProcessing) {
      logger.info('Waiting for in-progress comcheck to finish (up to 60s)...');
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const current = orchestrator.getQueueStatus();
        if (!current.isProcessing) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  try {
    await stopSlackBot();
  } catch (error) {
    logger.error('Error stopping Slack bot', error);
  }

  try {
    await browserManager.close();
  } catch (error) {
    logger.error('Error closing browser', error);
  }

  if (conversationManager) {
    conversationManager.close();
  }
  if (requestTracker) {
    requestTracker.close();
  }

  logger.info('Shutdown complete.');
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

main();
