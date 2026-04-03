import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('security');

const allowedSet = new Set(config.allowedUserIds);
const adminSet = new Set(config.adminUserIds);

// Log whitelist on startup
logger.info(`Whitelist loaded: ${allowedSet.size + adminSet.size} users authorized (${allowedSet.size} dispatchers, ${adminSet.size} admins)`);

/**
 * Check if a Slack user is allowed to request comchecks.
 * Admins are always allowed. Fails closed — if no users configured, everyone is blocked.
 */
export function isAllowedUser(slackUserId: string): boolean {
  return allowedSet.has(slackUserId) || adminSet.has(slackUserId);
}

/**
 * Check if a Slack user has admin privileges (e.g., /comcheck-status).
 */
export function isAdmin(slackUserId: string): boolean {
  return adminSet.has(slackUserId);
}
