import { WebClient } from '@slack/web-api';
import { browserManager } from '../browser/browser-manager';
import { RequestTracker } from '../state/request-tracker';
import { ComCheckOrchestrator } from '../orchestrator';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('health');

const startTime = Date.now();

export interface HealthStatus {
  slackConnected: boolean;
  browserStatus: 'alive' | 'dead' | 'restarting';
  lastSuccessfulComCheck: string | null;
  queueDepth: number;
  queueProcessing: boolean;
  uptimeMs: number;
  uptimeFormatted: string;
}

export class HealthMonitor {
  private consecutiveFailures = 0;
  private lastResponseTime = Date.now();
  private dailySummaryInterval: NodeJS.Timeout | null = null;
  private alertCheckInterval: NodeJS.Timeout | null = null;
  private slackClient: WebClient;

  constructor(
    private tracker: RequestTracker,
    private orchestrator: ComCheckOrchestrator
  ) {
    this.slackClient = new WebClient(config.slack.botToken);
  }

  async getHealth(): Promise<HealthStatus> {
    const browserAlive = await browserManager.isHealthy();
    const queueStatus = this.orchestrator.getQueueStatus();
    const lastComCheck = this.tracker.getLastCompletedAt();
    const uptimeMs = Date.now() - startTime;

    return {
      slackConnected: true, // if we're running, we're connected via Socket Mode
      browserStatus: browserAlive ? 'alive' : 'dead',
      lastSuccessfulComCheck: lastComCheck,
      queueDepth: queueStatus.queueLength,
      queueProcessing: queueStatus.isProcessing,
      uptimeMs,
      uptimeFormatted: this.formatUptime(uptimeMs),
    };
  }

  /** Record that a message was handled (for unresponsive detection) */
  recordActivity(): void {
    this.lastResponseTime = Date.now();
  }

  /** Record browser automation outcome (for consecutive failure alerting) */
  recordAutomationResult(success: boolean): void {
    if (success) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3) {
        this.postAlert(
          `Browser automation has failed ${this.consecutiveFailures} times in a row. Investigate immediately.`
        );
      }
    }
  }

  /** Start the monitoring loops */
  start(): void {
    // Daily summary at midnight (check every minute, fire at 00:00)
    this.dailySummaryInterval = setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        this.postDailySummary();
      }
    }, 60_000);

    // Unresponsive check every minute
    this.alertCheckInterval = setInterval(() => {
      const silenceMs = Date.now() - this.lastResponseTime;
      if (silenceMs > 5 * 60 * 1000) {
        this.postAlert('Bot has been unresponsive for over 5 minutes.');
        this.lastResponseTime = Date.now(); // reset to avoid repeat alerts
      }
    }, 60_000);

    logger.info('Health monitoring started');
  }

  stop(): void {
    if (this.dailySummaryInterval) {
      clearInterval(this.dailySummaryInterval);
      this.dailySummaryInterval = null;
    }
    if (this.alertCheckInterval) {
      clearInterval(this.alertCheckInterval);
      this.alertCheckInterval = null;
    }
  }

  formatHealthForSlack(health: HealthStatus): string {
    const todayStats = this.tracker.getTodayStats();
    const avgSec = todayStats.avgDurationMs
      ? `${(todayStats.avgDurationMs / 1000).toFixed(1)}s`
      : 'N/A';

    return [
      `*System Health*`,
      `Browser: ${health.browserStatus === 'alive' ? 'Healthy' : 'DOWN'}`,
      `Slack: ${health.slackConnected ? 'Connected' : 'Disconnected'}`,
      `Uptime: ${health.uptimeFormatted}`,
      `Queue: ${health.queueDepth} pending${health.queueProcessing ? ' (processing)' : ''}`,
      `Last comcheck: ${health.lastSuccessfulComCheck || 'None today'}`,
      ``,
      `*Today's Stats*`,
      `Total requests: ${todayStats.total}`,
      `Completed: ${todayStats.completed}`,
      `Failed: ${todayStats.failed}`,
      `Avg creation time: ${avgSec}`,
    ].join('\n');
  }

  private async postDailySummary(): Promise<void> {
    if (!config.logChannelId) return;

    try {
      const todayStats = this.tracker.getTodayStats();
      const health = await this.getHealth();
      const avgSec = todayStats.avgDurationMs
        ? `${(todayStats.avgDurationMs / 1000).toFixed(1)}s`
        : 'N/A';

      const text = [
        `*Daily Summary* — ${new Date().toLocaleDateString()}`,
        `Uptime: ${health.uptimeFormatted}`,
        `Comchecks created: ${todayStats.completed}`,
        `Failed: ${todayStats.failed}`,
        `Avg creation time: ${avgSec}`,
        todayStats.failed > 0 ? `\n:warning: ${todayStats.failed} failures today — check logs.` : '',
      ].filter(Boolean).join('\n');

      await this.slackClient.chat.postMessage({
        channel: config.logChannelId,
        text,
      });
      logger.info('Daily summary posted');
    } catch (error) {
      logger.error('Failed to post daily summary', error);
    }
  }

  private async postAlert(message: string): Promise<void> {
    logger.error(message);

    if (!config.logChannelId) return;

    try {
      await this.slackClient.chat.postMessage({
        channel: config.logChannelId,
        text: `<!channel> :rotating_light: *ALERT* — ${message}`,
      });
    } catch (error) {
      logger.error('Failed to post alert to Slack', error);
    }
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
  }
}
