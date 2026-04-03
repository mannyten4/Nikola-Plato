import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { getSystemPrompt } from './system-prompt';
import { tools, CreateComcheckInput } from './tools';
import { ConversationManager } from './conversation';
import { RequestTracker } from '../state/request-tracker';

export interface AgentResponse {
  text: string;
  toolCall?: {
    name: string;
    input: CreateComcheckInput;
    toolUseId: string;
  };
}

export class AgentBrain {
  private client: Anthropic;
  private conversationManager: ConversationManager;
  private tracker: RequestTracker | null;

  constructor(conversationManager: ConversationManager, tracker?: RequestTracker) {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
    this.conversationManager = conversationManager;
    this.tracker = tracker || null;
  }

  async processMessage(
    threadId: string,
    userMessage: string,
    userName?: string,
    userId?: string
  ): Promise<AgentResponse> {
    // Format with user name context
    const formattedMessage = userName
      ? `Message from ${userName}: ${userMessage}`
      : userMessage;

    // Add to conversation history
    this.conversationManager.addMessage(threadId, 'user', formattedMessage);

    // Get full conversation history
    const history = this.conversationManager.getHistory(threadId);

    // Build user context from recent requests
    let userContext: Parameters<typeof getSystemPrompt>[0];
    if (this.tracker) {
      const dailyTotal = this.tracker.getDailyTotal();
      userContext = { dailyTotal };

      if (userId) {
        const recent = this.tracker.getRequestsByUser(userId, 5);
        if (recent.length > 0) {
          userContext.recentRequests = recent.map((r) => ({
            payee_name: r.payee_name,
            amount: r.amount,
            memo: r.memo,
            status: r.status,
            created_at: r.created_at,
          }));
        }
      }
    }

    // Call Claude API
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: getSystemPrompt(userContext),
      tools,
      messages: history,
    });

    // Extract text and tool use from response
    let text = '';
    let toolCall: AgentResponse['toolCall'] | undefined;

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCall = {
          name: block.name,
          input: block.input as CreateComcheckInput,
          toolUseId: block.id,
        };
        console.log(`[agent] Tool call: ${block.name}`, JSON.stringify(block.input));
      }
    }

    // Store assistant response in conversation history
    if (text) {
      this.conversationManager.addMessage(threadId, 'assistant', text);
    }

    return { text, toolCall };
  }
}
