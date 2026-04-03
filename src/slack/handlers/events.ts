import { App } from '@slack/bolt';
import { isAllowedChannel } from '../middleware/auth';
import { isAdmin } from '../../security/access-control';
import { AgentBrain } from '../../ai/agent';
import { RequestTracker } from '../../state/request-tracker';
import { sendOnDemandReport } from '../../reporting/daily-reports';

export function registerEventHandlers(app: App, agent: AgentBrain, tracker: RequestTracker): void {
  app.event('app_mention', async ({ event, client, say }) => {
    const isDM = (event as any).channel_type === 'im';
    if (!isDM && !isAllowedChannel(event.channel)) return;

    const threadTs = event.thread_ts || event.ts;
    const userId = event.user || 'unknown';

    try {
      // Look up display name
      let userName: string | undefined;
      try {
        const userInfo = await client.users.info({ user: userId });
        userName =
          userInfo.user?.profile?.display_name ||
          userInfo.user?.real_name ||
          userInfo.user?.name;
      } catch {
        // Non-critical
      }

      // Strip the @mention from the text
      const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
      if (!text) return;

      // Admin manual report trigger: "@Nikola report"
      if (/^report$/i.test(text) && isAdmin(userId)) {
        await sendOnDemandReport(client, tracker, event.channel, threadTs);
        return;
      }

      console.log(`[slack] Mention from ${userName || userId}: ${text}`);
      const response = await agent.processMessage(threadTs, text, userName);

      if (response.text) {
        console.log(`[slack] Reply: ${response.text}`);
        await say({
          text: response.text,
          thread_ts: threadTs,
        });
      }

      if (response.toolCall && response.toolCall.name === 'create_comcheck') {
        const input = response.toolCall.input;

        const existing = tracker.getActiveRequest(threadTs);
        if (existing && (existing.status === 'processing' || existing.status === 'completed')) {
          await say({
            text: "There's already a pending request in this thread. Let me finish that one first!",
            thread_ts: threadTs,
          });
          return;
        }

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
        tracker.updateRequest(request.id, { status: 'processing' });

        await say({
          text: "Got it! Creating that comcheck now... give me a moment \u23F3",
          thread_ts: threadTs,
        });

        console.log(`[tracker] Request ${request.id} is processing:`, input);
      }
    } catch (error) {
      console.error('[slack] Error processing mention:', error);
      await say({
        text: "Hmm, something went sideways on my end. Give me a minute and try again?",
        thread_ts: threadTs,
      });
    }
  });
}
