import * as cron from 'node-cron';
import { WebClient } from '@slack/web-api';
import { RequestTracker, ComcheckRequest } from '../state/request-tracker';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('reporting');

const tz = config.timezone;

/**
 * Convert a local date/time to a UTC ISO string for SQLite queries.
 * E.g., toUtcIso(2026, 3, 3, 17, 0) with tz "America/New_York" → UTC equivalent.
 */
function toUtcIso(year: number, month: number, day: number, hour: number, minute: number): string {
  // Build a date string in the target timezone, then convert to UTC
  const localStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  // Create date by interpreting localStr in the configured timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  // Use a reference approach: find UTC offset for that local time
  const refDate = new Date(localStr + 'Z'); // treat as UTC first
  const utcParts = getDateParts(refDate, 'UTC');
  const localParts = getDateParts(refDate, tz);
  const offsetMs = (
    Date.UTC(utcParts.year, utcParts.month, utcParts.day, utcParts.hour, utcParts.minute) -
    Date.UTC(localParts.year, localParts.month, localParts.day, localParts.hour, localParts.minute)
  );
  const targetUtc = new Date(refDate.getTime() + offsetMs);
  // Adjust: we want localStr in tz → UTC
  // local time = UTC + offset, so UTC = local - offset
  const result = new Date(Date.UTC(year, month, day, hour, minute, 0) - offsetMs);
  return result.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function getDateParts(date: Date, timeZone: string) {
  const parts: Record<string, number> = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric',
    hour12: false,
  });
  for (const p of formatter.formatToParts(date)) {
    if (p.type === 'year') parts.year = parseInt(p.value);
    if (p.type === 'month') parts.month = parseInt(p.value) - 1;
    if (p.type === 'day') parts.day = parseInt(p.value);
    if (p.type === 'hour') parts.hour = parseInt(p.value) % 24;
    if (p.type === 'minute') parts.minute = parseInt(p.value);
  }
  return parts as { year: number; month: number; day: number; hour: number; minute: number };
}

/** Get "now" broken into parts in the configured timezone */
function nowLocal(): { year: number; month: number; day: number; hour: number; minute: number } {
  return getDateParts(new Date(), tz);
}

/** Format a date for display in the configured timezone */
function formatLocalTime(utcDateStr: string): string {
  const d = new Date(utcDateStr.endsWith('Z') ? utcDateStr : utcDateStr + 'Z');
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });
}

function formatLocalDate(year: number, month: number, day: number): string {
  const d = new Date(year, month, day);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Generate a report for comchecks completed within a time window.
 * Returns Slack Block Kit blocks ready to post.
 */
export function generateReport(
  requests: ComcheckRequest[],
  title: string,
  emptyMessage: string
): { blocks: any[]; text: string } {
  if (requests.length === 0) {
    return {
      text: `${title}\n${emptyMessage}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: title } },
        { type: 'section', text: { type: 'mrkdwn', text: emptyMessage } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Report generated at ${new Date().toLocaleTimeString('en-US', { timeZone: tz })}` }] },
      ],
    };
  }

  const totalAmount = requests.reduce((sum, r) => sum + (r.amount || 0), 0);

  const lines = requests.map((r) => {
    const time = r.completed_at ? formatLocalTime(r.completed_at) : '—';
    const amount = r.amount != null ? `$${r.amount.toFixed(2)}` : '—';
    const payee = r.payee_name || '—';
    const requestedBy = r.slack_user_name || '—';
    const memo = r.memo || '—';
    const loadNum = r.reference_number ? `load #${r.reference_number}` : '';
    const expressCode = r.express_code || '—';

    return `:clock1: ${time} — ${amount} to ${payee}\n    Requested by: ${requestedBy} (${memo}${loadNum ? ', ' + loadNum : ''})\n    Express code: \`${expressCode}\``;
  });

  const summary = `*Total: ${requests.length} com check${requests.length === 1 ? '' : 's'} | $${totalAmount.toFixed(2)}*`;

  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: title } },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    { type: 'divider' },
  ];

  // Add each comcheck as a section (batch in groups to stay under block limits)
  for (const line of lines) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: line } });
  }

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Report generated at ${new Date().toLocaleTimeString('en-US', { timeZone: tz })}` }] });

  return {
    text: `${title} — ${requests.length} com checks, $${totalAmount.toFixed(2)}`,
    blocks,
  };
}

/** Send the business hours report (9 AM → 5 PM today) */
async function sendBusinessHoursReport(client: WebClient, tracker: RequestTracker): Promise<void> {
  const now = nowLocal();
  const startUtc = toUtcIso(now.year, now.month, now.day, 9, 0);
  const endUtc = toUtcIso(now.year, now.month, now.day, 17, 0);

  const requests = tracker.getCompletedInWindow(startUtc, endUtc);
  const dateStr = formatLocalDate(now.year, now.month, now.day);
  const title = `Business hours report — ${dateStr}`;

  const { blocks, text } = generateReport(requests, title, 'No com checks created during business hours today.');

  const channel = config.reportChannelId || config.logChannelId || config.slack.channelId;
  await client.chat.postMessage({ channel, blocks, text });
  logger.info(`Business hours report sent: ${requests.length} comchecks`);
}

/** Send the overnight report (5 PM yesterday → 9 AM today) */
async function sendOvernightReport(client: WebClient, tracker: RequestTracker): Promise<void> {
  const now = nowLocal();
  // Yesterday at 5 PM
  const yesterday = new Date(now.year, now.month, now.day);
  yesterday.setDate(yesterday.getDate() - 1);
  const startUtc = toUtcIso(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 17, 0);
  // Today at 9 AM
  const endUtc = toUtcIso(now.year, now.month, now.day, 9, 0);

  const requests = tracker.getCompletedInWindow(startUtc, endUtc);
  const yesterdayStr = formatLocalDate(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
  const todayStr = formatLocalDate(now.year, now.month, now.day);
  const title = `Overnight report — ${yesterdayStr} 5PM → ${todayStr} 9AM`;

  const { blocks, text } = generateReport(requests, title, 'No com checks created overnight.');

  const channel = config.reportChannelId || config.logChannelId || config.slack.channelId;
  await client.chat.postMessage({ channel, blocks, text });
  logger.info(`Overnight report sent: ${requests.length} comchecks`);
}

/** Generate an on-demand report for today so far (midnight → now) */
export async function sendOnDemandReport(client: WebClient, tracker: RequestTracker, channel: string, threadTs?: string): Promise<void> {
  const now = nowLocal();
  const startUtc = toUtcIso(now.year, now.month, now.day, 0, 0);
  const endUtc = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  const requests = tracker.getCompletedInWindow(startUtc, endUtc);
  const dateStr = formatLocalDate(now.year, now.month, now.day);
  const title = `On-demand report — ${dateStr} (so far)`;

  const { blocks, text } = generateReport(requests, title, 'No com checks created today so far.');

  await client.chat.postMessage({ channel, blocks, text, thread_ts: threadTs });
  logger.info(`On-demand report sent: ${requests.length} comchecks`);
}

/** Scheduled cron tasks */
let businessHoursTask: ReturnType<typeof cron.schedule> | null = null;
let overnightTask: ReturnType<typeof cron.schedule> | null = null;

/** Start the daily report schedulers */
export function startReportScheduler(client: WebClient, tracker: RequestTracker): void {
  // 5:00 PM every day
  businessHoursTask = cron.schedule('0 17 * * *', async () => {
    try {
      await sendBusinessHoursReport(client, tracker);
    } catch (err) {
      logger.error('Failed to send business hours report', err);
    }
  }, { timezone: tz });

  // 9:00 AM every day
  overnightTask = cron.schedule('0 9 * * *', async () => {
    try {
      await sendOvernightReport(client, tracker);
    } catch (err) {
      logger.error('Failed to send overnight report', err);
    }
  }, { timezone: tz });

  logger.info(`Report scheduler started (timezone: ${tz}) — business hours at 5PM, overnight at 9AM`);
}

/** Stop the schedulers on shutdown */
export function stopReportScheduler(): void {
  if (businessHoursTask) {
    businessHoursTask.stop();
    businessHoursTask = null;
  }
  if (overnightTask) {
    overnightTask.stop();
    overnightTask = null;
  }
  logger.info('Report scheduler stopped');
}
