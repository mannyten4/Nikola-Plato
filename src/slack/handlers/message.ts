import { App } from '@slack/bolt';
import { isAllowedChannel } from '../middleware/auth';
import { isAllowedUser } from '../../security/access-control';
import { AgentBrain } from '../../ai/agent';
import { RequestTracker } from '../../state/request-tracker';
import { ComCheckOrchestrator } from '../../orchestrator';
import { HealthMonitor } from '../../monitoring/health';
import { createLogger } from '../../utils/logger';

const logger = createLogger('slack');

// Rate limiting: max 5 requests per user per minute
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(userId, recent);

  if (recent.length >= RATE_LIMIT_MAX) {
    return true;
  }
  recent.push(now);
  return false;
}

export function registerMessageHandler(app: App, agent: AgentBrain, tracker: RequestTracker, orchestrator: ComCheckOrchestrator, healthMonitor: HealthMonitor): void {
  app.message(async ({ message, client, say }) => {
    // Only handle regular user messages
    if (message.subtype) return;
    if (!('text' in message) || !message.text) return;
    if ('bot_id' in message && message.bot_id) return;

    // Check channel type
    const channelType = (message as any).channel_type;
    const isDM = channelType === 'im';

    // Skip @mentions in channels — handled by the app_mention event handler
    if (!isDM && message.text.match(/<@[A-Z0-9]+>/)) return;

    // Check channel authorization — allow DMs and the designated channel
    if (!isDM && !isAllowedChannel(message.channel)) return;

    const userId = ('user' in message ? message.user : undefined) || 'unknown';
    const threadTs = ('thread_ts' in message ? message.thread_ts : undefined) || message.ts;

    // User whitelist check
    if (!isAllowedUser(userId)) {
      logger.warn(`Unauthorized access attempt: userId=${userId}, text="${message.text}"`);
      tracker.logSecurityEvent('unauthorized_user', userId, null, message.channel, message.text);
      await say({
        text: "Hey! I don't think I have you on my list yet. You'll need to check with Manny to get set up for comcheck requests.",
        thread_ts: threadTs,
      });
      return;
    }

    // Rate limiting
    if (isRateLimited(userId)) {
      await say({
        text: "Hey, give me a sec to catch up! I'll be right with you.",
        thread_ts: threadTs,
      });
      return;
    }

    try {
      // Look up user display name
      let userName: string | undefined;
      try {
        const userInfo = await client.users.info({ user: userId });
        userName =
          userInfo.user?.profile?.display_name ||
          userInfo.user?.real_name ||
          userInfo.user?.name;
      } catch {
        // Non-critical — proceed without name
      }

      // Process through AI agent (pass userId for history context)
      healthMonitor.recordActivity();
      logger.info(`Message from ${userName || userId}: ${message.text}`);
      const response = await agent.processMessage(threadTs, message.text, userName, userId);

      // Post AI text response
      if (response.text) {
        logger.debug(`Reply: ${response.text}`);
        await say({
          text: response.text,
          thread_ts: threadTs,
        });
      }

      // Handle tool calls with request tracking
      if (response.toolCall && response.toolCall.name === 'create_comcheck') {
        const input = response.toolCall.input;
        logger.info(`Tool call: ${response.toolCall.name} — ${input.payee_name} $${input.amount}`);

        // Check for existing active request in this thread
        const existing = tracker.getActiveRequest(threadTs);
        if (existing && (existing.status === 'processing' || existing.status === 'completed')) {
          await say({
            text: "There's already a pending request in this thread. Let me finish that one first!",
            thread_ts: threadTs,
          });
          return;
        }

        // Duplicate guard: check if a comcheck for this load was already created recently
        if (input.reference_number) {
          const duplicate = tracker.findRecentByLoadNumber(input.reference_number);
          if (duplicate) {
            const timeAgo = duplicate.completed_at
              ? `at ${duplicate.completed_at}`
              : 'recently';
            logger.warn(`Duplicate blocked: load ${input.reference_number} already has comcheck ${duplicate.express_code}`);
            await say({
              text: `Heads up — a comcheck for load ${input.reference_number} was already created ${timeAgo} (express code: \`${duplicate.express_code}\`, $${duplicate.amount} for ${duplicate.payee_name}). Did you need a second one for the same load? Let me know and I'll create it.`,
              thread_ts: threadTs,
            });
            return;
          }
        }

        // Create or update request record
        let request = existing;
        if (!request) {
          request = tracker.createRequest(threadTs, userId, userName || userId);
        }

        tracker.updateRequest(request.id, {
          status: 'confirmed',
          payee_name: input.payee_name,
          amount: input.amount,
          memo: input.memo,
          reference_number: input.reference_number,
        });

        // Move to processing
        tracker.updateRequest(request.id, { status: 'processing' });

        await say({
          text: "Got it! Creating that comcheck now... give me a moment ⏳",
          thread_ts: threadTs,
        });

        // Fire-and-forget: orchestrator processes asynchronously
        orchestrator.executeComCheck(request.id, input, threadTs, userId)
          .then(async (result) => {
            healthMonitor.recordAutomationResult(true);
            logger.info(`Request ${request.id} completed: ${result.expressCode}`, request.id);

            // Add ✅ reaction to the user's original message
            try {
              await client.reactions.add({
                channel: message.channel,
                name: 'white_check_mark',
                timestamp: message.ts,
              });
            } catch {
              // Non-critical — reaction may already exist
            }

            // Send Block Kit formatted response with express code
            await client.chat.postMessage({
              channel: message.channel,
              thread_ts: threadTs,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `All set! Here's the express code:`,
                  },
                },
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `\`${result.expressCode}\``,
                  },
                },
                {
                  type: 'context',
                  elements: [
                    {
                      type: 'mrkdwn',
                      text: `Confirmation: ${result.confirmationNumber} | $${input.amount} for ${input.payee_name}`,
                    },
                  ],
                },
              ],
              text: `Express code: ${result.expressCode} (Confirmation: ${result.confirmationNumber})`,
            });
          })
          .catch(async (error) => {
            healthMonitor.recordAutomationResult(false);
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(`Request ${request.id} failed`, error, request.id);
            await say({
              text: `I ran into an issue creating that check. ${errorMsg}\n\nWant me to try again?`,
              thread_ts: threadTs,
            });
          });
      }
    } catch (error) {
      logger.error('Error processing message', error);
      await say({
        text: "Hmm, something went sideways on my end. Give me a minute and try again?",
        thread_ts: threadTs,
      });
    }
  });
}
