import { ComdataAutomation } from '../browser/comdata-automation';
import { browserManager } from '../browser/browser-manager';
import { RequestTracker } from '../state/request-tracker';
import { CreateComcheckInput } from '../ai/tools';
import { ComCheckRequest, ComCheckResult } from '../types';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('orchestrator');

const MAX_QUEUE_SIZE = 10;
const QUEUE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface QueueItem {
  requestId: string;
  input: CreateComcheckInput;
  threadTs: string;
  resolve: (result: ComCheckResult) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

export class ComCheckOrchestrator {
  private queue: QueueItem[] = [];
  private processing = false;

  constructor(
    private automation: ComdataAutomation,
    private tracker: RequestTracker
  ) {}

  async executeComCheck(
    requestId: string,
    input: CreateComcheckInput,
    threadTs: string
  ): Promise<ComCheckResult> {
    // Validate input
    this.validate(input);

    // Check queue capacity
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.tracker.failRequest(requestId, 'Queue full — too many pending requests');
      throw new Error('Queue full — too many pending requests. Please try again in a few minutes.');
    }

    // Enqueue and return a promise that resolves when processing completes
    return new Promise<ComCheckResult>((resolve, reject) => {
      this.queue.push({
        requestId,
        input,
        threadTs,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });

      logger.info(`Queued request ${requestId} (queue size: ${this.queue.length})`, requestId);
      this.processQueue();
    });
  }

  getQueueStatus(): { queueLength: number; isProcessing: boolean } {
    return { queueLength: this.queue.length, isProcessing: this.processing };
  }

  private validate(input: CreateComcheckInput): void {
    if (!input.payee_name || input.payee_name.trim().length === 0) {
      throw new Error('Payee name is required.');
    }
    if (!input.amount || input.amount <= 0) {
      throw new Error('Amount must be greater than zero.');
    }
    if (input.amount > config.comcheckMaxAmount) {
      throw new Error(
        `Amount $${input.amount} exceeds the maximum of $${config.comcheckMaxAmount}.`
      );
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      await this.processItem(item);
    }

    this.processing = false;
  }

  private async processItem(item: QueueItem): Promise<void> {
    // Check if item has been waiting too long in the queue
    if (Date.now() - item.enqueuedAt > QUEUE_TIMEOUT_MS) {
      const error = new Error('Request timed out while waiting in queue.');
      this.tracker.failRequest(item.requestId, error.message);
      item.reject(error);
      return;
    }

    try {
      const result = await this.executeWithRetry(item);
      this.tracker.completeRequest(item.requestId, result.expressCode, result.confirmationNumber);
      logger.info(`Request ${item.requestId} completed: express=${result.expressCode}`, item.requestId);
      item.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.tracker.failRequest(item.requestId, message);
      logger.error(`Request ${item.requestId} failed: ${message}`, undefined, item.requestId);
      item.reject(error instanceof Error ? error : new Error(message));
    }
  }

  private async executeWithRetry(item: QueueItem): Promise<ComCheckResult> {
    const comCheckRequest = this.mapInput(item.input);

    // Attempt 1
    try {
      return await this.executeWithTimeout(comCheckRequest);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // Form errors — don't retry
      if (!this.isSessionError(err)) {
        throw err;
      }

      // Session error — restart browser and retry
      logger.warn('Session error on attempt 1, restarting browser...');
      try {
        await browserManager.restart();
      } catch (restartErr) {
        logger.error('Browser restart failed', restartErr);
        throw err; // throw original error
      }
    }

    // Attempt 2
    logger.info(`Retrying request ${item.requestId} (attempt 2)...`, item.requestId);
    return await this.executeWithTimeout(comCheckRequest);
  }

  private async executeWithTimeout(request: ComCheckRequest): Promise<ComCheckResult> {
    return Promise.race([
      this.automation.createComCheck(request),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Comcheck creation timed out after 5 minutes.')),
          EXECUTION_TIMEOUT_MS
        )
      ),
    ]);
  }

  private mapInput(input: CreateComcheckInput): ComCheckRequest {
    const { firstName, lastName } = this.splitPayeeName(input.payee_name);
    return {
      amount: input.amount,
      driverFirstName: firstName,
      driverLastName: lastName,
      unitNumber: input.unit_number,
      purposeCode: input.memo,
    };
  }

  private splitPayeeName(payeeName: string): { firstName: string; lastName: string } {
    const parts = payeeName.trim().split(/\s+/);
    if (parts.length === 1) {
      return { firstName: parts[0], lastName: parts[0] };
    }
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }

  private isSessionError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return ['session', 'expired', 'login', 'authentication', 'not responsive', 'unhealthy'].some(
      (keyword) => msg.includes(keyword)
    );
  }
}
