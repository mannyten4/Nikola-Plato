import { Page } from 'playwright';
import { WebClient } from '@slack/web-api';
import { selectors } from './selectors';
import { browserManager } from './browser-manager';
import { waitAndClick, waitAndFill, humanDelay } from './page-helpers';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('browser');

const MAX_CODE_ATTEMPTS = 3;
const SLACK_POLL_INTERVAL_MS = 3_000;
const CODE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MANUAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MANUAL_POLL_INTERVAL_MS = 5_000;

/**
 * Extracts a numeric verification code from a Slack message.
 * Handles formats like "123456", "code is 123456", "1 2 3 4 5 6".
 */
export function extractCode(text: string): string | null {
  const digitsOnly = text.replace(/\D/g, '');
  if (digitsOnly.length >= 4 && digitsOnly.length <= 8) {
    return digitsOnly;
  }
  return null;
}

/**
 * Polls a Slack thread for a reply from a specific user.
 * Returns the message text or null on timeout.
 */
async function waitForSlackReply(
  client: WebClient,
  channel: string,
  threadTs: string,
  fromUserId: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 10,
      });

      const replies = result.messages || [];
      // Skip the first message (the bot's own prompt) and find a reply from the admin
      for (let i = 1; i < replies.length; i++) {
        const msg = replies[i];
        if (msg.user === fromUserId && msg.text) {
          return msg.text;
        }
      }
    } catch (err) {
      logger.error('Error polling Slack thread for 2FA reply', err);
    }

    await new Promise((resolve) => setTimeout(resolve, SLACK_POLL_INTERVAL_MS));
  }

  return null;
}

export class TwoFactorHandler {
  private page: Page;
  private client: WebClient;
  private channel: string;
  private adminUserId: string;

  constructor(page: Page, client: WebClient) {
    this.page = page;
    this.client = client;
    this.channel = config.logChannelId || config.slack.channelId;
    this.adminUserId = config.adminSlackUserId;
  }

  /**
   * Main entry point: detects 2FA, requests code via Slack, enters it.
   * Returns true if login succeeded, false if 2FA could not be resolved.
   */
  async handle(): Promise<boolean> {
    logger.info('2FA detected — starting Slack-based code relay');

    // Try to click "Send SMS" button to trigger the code
    const sendButtonClicked = await this.trySendSms();
    if (!sendButtonClicked) {
      logger.warn('Could not find or click Send SMS button — falling back to manual');
      return this.fallbackManualCompletion();
    }

    await browserManager.screenshot('06-2fa-sms-sent');

    // Post to Slack asking the admin for the code
    let threadTs: string;
    try {
      const result = await this.client.chat.postMessage({
        channel: this.channel,
        text: `<@${this.adminUserId}> Hey! I need a 2FA verification code to log into Comdata. I just sent the SMS to your phone. Reply here with the code and I'll punch it in.`,
      });
      threadTs = result.ts!;
      logger.info(`2FA code request posted to Slack (thread: ${threadTs})`);
    } catch (err) {
      logger.error('Failed to post 2FA Slack message', err);
      return this.fallbackManualCompletion();
    }

    // Poll for replies and try codes
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
      logger.info(`Waiting for 2FA code reply (attempt ${attempt}/${MAX_CODE_ATTEMPTS})`);

      const replyText = await waitForSlackReply(
        this.client,
        this.channel,
        threadTs,
        this.adminUserId,
        CODE_TIMEOUT_MS,
      );

      if (!replyText) {
        logger.warn('No 2FA code received within timeout');
        await this.replyInThread(threadTs, 'Timed out waiting for the code. Switching to manual fallback.');
        return this.fallbackManualCompletion();
      }

      const code = extractCode(replyText);
      if (!code) {
        logger.warn(`Could not extract code from reply: "${replyText}"`);
        await this.replyInThread(threadTs, `I couldn't find a code in that message. Send me just the numeric code (e.g. "123456").`);
        continue;
      }

      logger.info(`Entering 2FA code (attempt ${attempt})`);

      // Fill the code and submit
      const success = await this.enterCode(code);

      if (success) {
        await browserManager.screenshot('07-2fa-success');
        await this.replyInThread(threadTs, "Got it, we're in! ✅");
        logger.info('2FA completed successfully');
        return true;
      }

      // Code was wrong
      await browserManager.screenshot(`07-2fa-failed-attempt-${attempt}`);

      if (attempt < MAX_CODE_ATTEMPTS) {
        await this.replyInThread(threadTs, "Hmm, that code didn't work. Can you send me a new one?");
      } else {
        await this.replyInThread(threadTs, "That code didn't work either. Switching to manual fallback.");
      }
    }

    // All attempts exhausted
    logger.warn('All 2FA code attempts failed');
    return this.fallbackManualCompletion();
  }

  /**
   * Try to click the "Send SMS" button to trigger the verification code.
   */
  private async trySendSms(): Promise<boolean> {
    try {
      const sendButton = this.page.locator(selectors.twoFactor.sendSmsButton).first();
      const visible = await sendButton.isVisible({ timeout: 5000 }).catch(() => false);

      if (!visible) {
        logger.info('Send SMS button not found — code may have been sent automatically');
        // Some 2FA flows auto-send. Return true to proceed with code entry.
        return true;
      }

      await sendButton.click();
      await humanDelay(this.page);
      logger.info('Clicked Send SMS button');
      return true;
    } catch (err) {
      logger.error('Error clicking Send SMS button', err);
      return false;
    }
  }

  /**
   * Fill the 2FA code input and click submit. Returns true if login succeeded.
   */
  private async enterCode(code: string): Promise<boolean> {
    try {
      // Fill the code
      const codeInput = this.page.locator(selectors.twoFactor.codeInput).first();
      await codeInput.waitFor({ state: 'visible', timeout: 5000 });
      await codeInput.fill('');
      await codeInput.type(code, { delay: 50 });
      await humanDelay(this.page);

      // Click verify/submit
      await waitAndClick(this.page, selectors.twoFactor.submitButton);
      await this.page.waitForLoadState('networkidle').catch(() => {});
      await humanDelay(this.page);

      // Check if we made it to the dashboard
      return await this.isMfaCleared();
    } catch (err) {
      logger.error('Error entering 2FA code', err);
      return false;
    }
  }

  /**
   * Check whether the MFA screen is gone (login succeeded).
   */
  private async isMfaCleared(): Promise<boolean> {
    // Check if we reached the dashboard URL
    if (this.page.url().includes(selectors.login.dashboard.dashboardUrl)) {
      return true;
    }

    // Check if MFA indicator is still visible
    const stillVisible = await this.page
      .locator(selectors.twoFactor.pageIndicator)
      .isVisible()
      .catch(() => false);

    return !stillVisible;
  }

  /**
   * Fallback: ask admin to complete 2FA manually in the browser window.
   */
  async fallbackManualCompletion(): Promise<boolean> {
    logger.info('Entering manual 2FA fallback — waiting for admin to complete in browser');

    try {
      const result = await this.client.chat.postMessage({
        channel: this.channel,
        text: `<@${this.adminUserId}> I couldn't handle the 2FA automatically. The browser is open — can you jump in and complete it manually? I'll wait up to 10 minutes.`,
      });
      const threadTs = result.ts!;

      const deadline = Date.now() + MANUAL_TIMEOUT_MS;

      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, MANUAL_POLL_INTERVAL_MS));

        const cleared = await this.isMfaCleared();
        if (cleared) {
          await browserManager.screenshot('07-2fa-manual-success');
          await this.replyInThread(threadTs, "Thanks! I'm back in. ✅");
          logger.info('2FA completed manually');
          return true;
        }
      }

      await this.replyInThread(threadTs, "Timed out waiting. I'll try again on the next comcheck request.");
      logger.warn('Manual 2FA fallback timed out');
      return false;
    } catch (err) {
      logger.error('Error in manual 2FA fallback', err);
      return false;
    }
  }

  /**
   * Post a threaded reply in the 2FA Slack thread.
   */
  private async replyInThread(threadTs: string, text: string): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: threadTs,
        text,
      });
    } catch (err) {
      logger.error('Failed to reply in 2FA thread', err);
    }
  }
}
