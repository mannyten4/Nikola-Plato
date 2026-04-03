import { WebClient } from '@slack/web-api';
import { RequestTracker } from '../state/request-tracker';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('app');

/**
 * Sends a daily comcheck summary to the Slack channel at 9 AM.
 * Shows all completed comchecks from the previous day in a table format.
 */
export async function sendDailyReport(
  client: WebClient,
  tracker: RequestTracker
): Promise<void> {
  const requests = tracker.getDailyReport();
  const channel = config.slack.channelId;

  if (requests.length === 0) {
    await client.chat.postMessage({
      channel,
      text: '📊 *Daily Comcheck Report* — No comchecks were processed today.',
    });
    logger.info('Daily report sent (no activity)');
    return;
  }

  const totalAmount = requests.reduce((sum, r) => sum + (r.amount || 0), 0);

  // Build the table rows
  const rows = requests.map((r) => {
    const time = r.created_at ? new Date(r.created_at + 'Z').toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/New_York',
    }) : '—';
    const requestedBy = r.slack_user_name || '—';
    const loadNum = r.reference_number || '—';
    const driver = r.payee_name || '—';
    const purpose = r.memo || '—';
    const amount = r.amount != null ? `$${r.amount.toFixed(2)}` : '—';

    return `| ${time} | ${requestedBy} | ${loadNum} | ${driver} | ${purpose} | ${amount} |`;
  });

  const table = [
    '| Time | Requested By | Load # | Driver/Payee | Purpose | Amount |',
    '|------|-------------|--------|-------------|---------|--------|',
    ...rows,
    `| | | | | *Total* | *$${totalAmount.toFixed(2)}* |`,
  ].join('\n');

  const message = `📊 *Daily Comcheck Report* — ${new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  })}

${requests.length} comcheck${requests.length === 1 ? '' : 's'} processed | Total: *$${totalAmount.toFixed(2)}* of $${config.dailyTotalLimit} daily limit

${table}`;

  await client.chat.postMessage({
    channel,
    text: message,
  });

  logger.info(`Daily report sent: ${requests.length} comchecks, $${totalAmount.toFixed(2)} total`);
}

/**
 * Schedule the daily report to run at 9:00 AM ET every day.
 * Returns the interval handle for cleanup.
 */
export function scheduleDailyReport(
  client: WebClient,
  tracker: RequestTracker
): NodeJS.Timeout {
  function msUntilNext9AM(): number {
    const now = new Date();
    const next9 = new Date(now);
    next9.setHours(9, 0, 0, 0);

    // If it's already past 9 AM today, schedule for tomorrow
    if (now >= next9) {
      next9.setDate(next9.getDate() + 1);
    }

    return next9.getTime() - now.getTime();
  }

  function scheduleNext() {
    const delay = msUntilNext9AM();
    logger.info(`Daily report scheduled in ${Math.round(delay / 60000)} minutes`);

    return setTimeout(async () => {
      try {
        await sendDailyReport(client, tracker);
      } catch (err) {
        logger.error('Failed to send daily report', err);
      }
      // Schedule the next one
      reportTimeout = scheduleNext();
    }, delay);
  }

  let reportTimeout = scheduleNext();
  return reportTimeout;
}
