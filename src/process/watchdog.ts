import { WebClient } from '@slack/web-api';
import { browserManager } from '../browser/browser-manager';
import { RequestTracker } from '../state/request-tracker';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('app');

const BROWSER_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const MAX_RESTART_FAILURES = 3;

const startTime = Date.now();

export class Watchdog {
  private browserCheckTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private restartFailures = 0;

  constructor(
    private slackClient: WebClient,
    private tracker: RequestTracker
  ) {}

  start(): void {
    // Browser health check every 5 minutes
    this.browserCheckTimer = setInterval(() => this.checkBrowser(), BROWSER_CHECK_INTERVAL_MS);

    // Heartbeat every 60 minutes
    this.heartbeatTimer = setInterval(() => this.logHeartbeat(), HEARTBEAT_INTERVAL_MS);

    logger.info('Watchdog started — browser check every 5m, heartbeat every 60m');
  }

  stop(): void {
    if (this.browserCheckTimer) {
      clearInterval(this.browserCheckTimer);
      this.browserCheckTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async checkBrowser(): Promise<void> {
    try {
      const healthy = await browserManager.isHealthy();

      if (healthy) {
        this.restartFailures = 0;
        return;
      }

      logger.warn('Browser unresponsive — attempting restart');
      await browserManager.restart();

      const stillHealthy = await browserManager.isHealthy();
      if (stillHealthy) {
        this.restartFailures = 0;
        logger.info('Browser restarted successfully');
        return;
      }

      this.restartFailures++;
      logger.error(`Browser restart failed (attempt ${this.restartFailures}/${MAX_RESTART_FAILURES})`);

      if (this.restartFailures >= MAX_RESTART_FAILURES) {
        await this.postAlert(
          '⚠️ Browser automation is down. Manual intervention needed.'
        );
        this.restartFailures = 0; // Reset to avoid spamming
      }
    } catch (err) {
      this.restartFailures++;
      logger.error('Browser check error', err);

      if (this.restartFailures >= MAX_RESTART_FAILURES) {
        await this.postAlert(
          '⚠️ Browser automation is down. Manual intervention needed.'
        );
        this.restartFailures = 0;
      }
    }
  }

  private async logHeartbeat(): Promise<void> {
    const uptimeMs = Date.now() - startTime;
    const uptimeH = (uptimeMs / 3600000).toFixed(1);
    const memMB = Math.round(process.memoryUsage.rss() / 1024 / 1024);
    const lastComcheck = this.tracker.getLastCompletedAt() || 'none';

    logger.info(
      `Heartbeat — uptime: ${uptimeH}h, memory: ${memMB}MB, last comcheck: ${lastComcheck}`
    );
  }

  private async postAlert(message: string): Promise<void> {
    const channel = config.logChannelId || config.slack.channelId;
    const adminTag = config.adminSlackUserId ? `<@${config.adminSlackUserId}> ` : '';

    try {
      await this.slackClient.chat.postMessage({
        channel,
        text: `${adminTag}${message}`,
      });
    } catch (err) {
      logger.error('Failed to post watchdog alert', err);
    }
  }
}
