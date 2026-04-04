import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue?: string): string | undefined {
  return process.env[name] || defaultValue;
}

export const config = {
  comdata: {
    username: requireEnv('COMDATA_USERNAME'),
    password: requireEnv('COMDATA_PASSWORD'),
    url: process.env.COMDATA_URL || 'https://www.comdata.com',
  },
  browser: {
    headless: process.env.BROWSER_HEADLESS === 'true',
    dataDir: path.resolve(process.env.BROWSER_DATA_DIR || './browser-data'),
  },
  slack: {
    botToken: requireEnv('SLACK_BOT_TOKEN'),
    appToken: requireEnv('SLACK_APP_TOKEN'),
    signingSecret: requireEnv('SLACK_SIGNING_SECRET'),
    channelId: requireEnv('SLACK_CHANNEL_ID'),
  },
  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
  },
  comcheckMaxAmount: parseInt(process.env.COMCHECK_MAX_AMOUNT || '1000', 10),
  lumperMaxAmount: parseInt(process.env.LUMPER_MAX_AMOUNT || '600', 10),
  repairMaxAmount: parseInt(process.env.REPAIR_MAX_AMOUNT || '1500', 10),
  dailyTotalLimit: parseInt(process.env.DAILY_TOTAL_LIMIT || '2500', 10),
  mockBrowser: process.env.MOCK_BROWSER === 'true',
  logChannelId: optionalEnv('LOG_CHANNEL_ID'),
  allowedUserIds: (process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  adminUserIds: (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  approvalUserId: process.env.APPROVAL_USER_ID || '',
  adminSlackUserId: optionalEnv('ADMIN_SLACK_USER_ID') || '',
  reportUserIds: (process.env.REPORT_USER_IDS || '').split(',').filter(Boolean),
  timezone: process.env.TIMEZONE || 'America/New_York',
  reportChannelId: process.env.REPORT_CHANNEL_ID || process.env.LOG_CHANNEL_ID || '',
  dashboard: {
    port: parseInt(process.env.DASHBOARD_PORT || '3000', 10),
    username: process.env.DASHBOARD_USERNAME || 'admin',
    password: process.env.DASHBOARD_PASSWORD || 'admin',
  },
} as const;
