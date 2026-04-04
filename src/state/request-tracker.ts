import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../utils/logger';

const logger = createLogger('app');

export type RequestStatus =
  | 'gathering_info'
  | 'pending_confirmation'
  | 'confirmed'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ComcheckRequest {
  id: string;
  slack_thread_ts: string;
  slack_user_id: string;
  slack_user_name: string;
  status: RequestStatus;
  payee_name: string | null;
  amount: number | null;
  memo: string | null;
  reference_number: string | null;
  express_code: string | null;
  confirmation_number: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export interface RequestStats {
  today_count: number;
  today_completed: number;
  today_failed: number;
  week_count: number;
  week_completed: number;
}

const DB_DIR = path.resolve('./data');
const DB_PATH = path.join(DB_DIR, 'browser-ai.db');

export class RequestTracker {
  private db: Database.Database;

  constructor() {
    fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.createTable();
  }

  private createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comcheck_requests (
        id TEXT PRIMARY KEY,
        slack_thread_ts TEXT NOT NULL,
        slack_user_id TEXT NOT NULL,
        slack_user_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'gathering_info',
        payee_name TEXT,
        amount REAL,
        memo TEXT,
        reference_number TEXT,
        express_code TEXT,
        confirmation_number TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        error_message TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_requests_thread
      ON comcheck_requests(slack_thread_ts, status)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_requests_user
      ON comcheck_requests(slack_user_id, created_at)
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        old_status TEXT,
        new_status TEXT NOT NULL,
        triggered_by TEXT NOT NULL DEFAULT 'system',
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        details TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_request
      ON audit_log(request_id, timestamp)
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slack_thread_ts TEXT,
        model_used TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_token_usage_date
      ON token_usage(created_at)
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        user_id TEXT,
        user_name TEXT,
        channel_id TEXT,
        message_text TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_security_events_date
      ON security_events(created_at)
    `);
  }

  createRequest(threadTs: string, userId: string, userName: string): ComcheckRequest {
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO comcheck_requests (id, slack_thread_ts, slack_user_id, slack_user_name)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, threadTs, userId, userName);

    this.logAudit(id, null, 'gathering_info', userId, `Request created by ${userName}`);

    return this.getRequest(id)!;
  }

  updateRequest(id: string, updates: Partial<Pick<ComcheckRequest,
    'status' | 'payee_name' | 'amount' | 'memo' | 'reference_number' | 'error_message'
  >>, triggeredBy = 'system'): void {
    // Capture old status for audit if status is changing
    let oldStatus: string | null = null;
    if (updates.status) {
      const current = this.getRequest(id);
      oldStatus = current?.status || null;
    }

    const fields: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db
      .prepare(`UPDATE comcheck_requests SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);

    if (updates.status) {
      this.logAudit(id, oldStatus, updates.status, triggeredBy);
    }
  }

  getRequest(id: string): ComcheckRequest | undefined {
    return this.db
      .prepare('SELECT * FROM comcheck_requests WHERE id = ?')
      .get(id) as ComcheckRequest | undefined;
  }

  getActiveRequest(threadTs: string): ComcheckRequest | undefined {
    return this.db
      .prepare(
        `SELECT * FROM comcheck_requests
         WHERE slack_thread_ts = ?
           AND status NOT IN ('completed', 'failed', 'cancelled')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(threadTs) as ComcheckRequest | undefined;
  }

  completeRequest(id: string, expressCode: string, confirmationNumber: string): void {
    const current = this.getRequest(id);
    this.db
      .prepare(
        `UPDATE comcheck_requests
         SET status = 'completed',
             express_code = ?,
             confirmation_number = ?,
             completed_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(expressCode, confirmationNumber, id);

    this.logAudit(id, current?.status || null, 'completed', 'orchestrator',
      `Express code: ${expressCode}, Confirmation: ${confirmationNumber}`);
  }

  failRequest(id: string, error: string): void {
    const current = this.getRequest(id);
    this.db
      .prepare(
        `UPDATE comcheck_requests
         SET status = 'failed',
             error_message = ?,
             completed_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(error, id);

    this.logAudit(id, current?.status || null, 'failed', 'orchestrator', error);
  }

  getRequestsByUser(userId: string, limit = 10): ComcheckRequest[] {
    return this.db
      .prepare(
        `SELECT * FROM comcheck_requests
         WHERE slack_user_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(userId, limit) as ComcheckRequest[];
  }

  getRequestStats(): RequestStats {
    const today = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM comcheck_requests
         WHERE created_at >= date('now')`
      )
      .get() as { total: number; completed: number; failed: number };

    const week = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
         FROM comcheck_requests
         WHERE created_at >= date('now', '-7 days')`
      )
      .get() as { total: number; completed: number };

    return {
      today_count: today.total,
      today_completed: today.completed || 0,
      today_failed: today.failed || 0,
      week_count: week.total,
      week_completed: week.completed || 0,
    };
  }

  /** Get completed comchecks within a time window (ISO strings in UTC) */
  getCompletedInWindow(startUtc: string, endUtc: string): ComcheckRequest[] {
    return this.db
      .prepare(
        `SELECT * FROM comcheck_requests
         WHERE status = 'completed'
           AND completed_at >= ?
           AND completed_at < ?
         ORDER BY completed_at ASC`
      )
      .all(startUtc, endUtc) as ComcheckRequest[];
  }

  /** Find a recently completed comcheck with the same load/reference number */
  findRecentByLoadNumber(referenceNumber: string, withinHours = 24): ComcheckRequest | undefined {
    return this.db
      .prepare(
        `SELECT * FROM comcheck_requests
         WHERE reference_number = ?
           AND status = 'completed'
           AND created_at >= datetime('now', '-' || ? || ' hours')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(referenceNumber, withinHours) as ComcheckRequest | undefined;
  }

  /** Cleanup stuck/stale requests */
  cleanup(): void {
    // Requests stuck in 'processing' for more than 10 minutes → failed
    const stuckRows = this.db
      .prepare(
        `SELECT id FROM comcheck_requests
         WHERE status = 'processing'
           AND updated_at < datetime('now', '-10 minutes')`
      )
      .all() as { id: string }[];

    for (const row of stuckRows) {
      this.failRequest(row.id, 'Timed out — stuck in processing for over 10 minutes');
      logger.warn(`Cleaned up stuck request ${row.id}`);
    }

    // Requests in 'gathering_info' for more than 24 hours → cancelled
    const staleRows = this.db
      .prepare(
        `SELECT id FROM comcheck_requests
         WHERE status = 'gathering_info'
           AND updated_at < datetime('now', '-24 hours')`
      )
      .all() as { id: string }[];

    for (const row of staleRows) {
      this.updateRequest(row.id, {
        status: 'cancelled',
        error_message: 'Automatically cancelled — inactive for over 24 hours',
      }, 'cleanup');
      logger.warn(`Cleaned up stale request ${row.id}`);
    }
  }

  getAuditLog(requestId: string): AuditEntry[] {
    return this.db
      .prepare(
        `SELECT * FROM audit_log WHERE request_id = ? ORDER BY timestamp ASC`
      )
      .all(requestId) as AuditEntry[];
  }

  getLastCompletedAt(): string | null {
    const row = this.db
      .prepare(
        `SELECT completed_at FROM comcheck_requests
         WHERE status = 'completed'
         ORDER BY completed_at DESC LIMIT 1`
      )
      .get() as { completed_at: string } | undefined;
    return row?.completed_at || null;
  }

  getTodayStats(): { total: number; completed: number; failed: number; avgDurationMs: number } {
    const stats = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM comcheck_requests
         WHERE created_at >= date('now')`
      )
      .get() as { total: number; completed: number; failed: number };

    const avgRow = this.db
      .prepare(
        `SELECT AVG(
           (julianday(completed_at) - julianday(created_at)) * 86400000
         ) as avg_ms
         FROM comcheck_requests
         WHERE status = 'completed'
           AND created_at >= date('now')
           AND completed_at IS NOT NULL`
      )
      .get() as { avg_ms: number | null };

    return {
      total: stats.total,
      completed: stats.completed || 0,
      failed: stats.failed || 0,
      avgDurationMs: avgRow.avg_ms || 0,
    };
  }

  /** Get total dollar amount of completed comchecks for today */
  getDailyTotal(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM comcheck_requests
         WHERE status = 'completed'
           AND created_at >= date('now')`
      )
      .get() as { total: number };
    return row.total;
  }

  /** Get all completed requests for today, for the daily report */
  getDailyReport(): ComcheckRequest[] {
    return this.db
      .prepare(
        `SELECT * FROM comcheck_requests
         WHERE status = 'completed'
           AND created_at >= date('now')
         ORDER BY created_at ASC`
      )
      .all() as ComcheckRequest[];
  }

  private logAudit(
    requestId: string,
    oldStatus: string | null,
    newStatus: string,
    triggeredBy: string,
    details?: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (request_id, old_status, new_status, triggered_by, details)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(requestId, oldStatus, newStatus, triggeredBy, details || null);
  }

  // ── Token usage tracking ──

  logTokenUsage(threadTs: string | null, model: string, inputTokens: number, outputTokens: number): void {
    const total = inputTokens + outputTokens;
    // Sonnet pricing: $3/M input, $15/M output
    const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
    this.db
      .prepare(
        `INSERT INTO token_usage (slack_thread_ts, model_used, input_tokens, output_tokens, total_tokens, estimated_cost)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(threadTs, model, inputTokens, outputTokens, total, cost);
  }

  getTokenUsageStats(): { today: TokenPeriod; week: TokenPeriod; month: TokenPeriod } {
    const query = (since: string) => this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
                COALESCE(SUM(output_tokens), 0) as output_tokens,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(estimated_cost), 0) as estimated_cost,
                COUNT(*) as request_count
         FROM token_usage WHERE created_at >= ${since}`
      )
      .get() as TokenPeriod;

    return {
      today: query("date('now')"),
      week: query("date('now', '-7 days')"),
      month: query("date('now', '-30 days')"),
    };
  }

  getTokenUsageDaily(days = 30): Array<{ date: string; total_tokens: number; estimated_cost: number }> {
    return this.db
      .prepare(
        `SELECT date(created_at) as date,
                SUM(total_tokens) as total_tokens,
                SUM(estimated_cost) as estimated_cost
         FROM token_usage
         WHERE created_at >= date('now', '-' || ? || ' days')
         GROUP BY date(created_at)
         ORDER BY date ASC`
      )
      .all(days) as Array<{ date: string; total_tokens: number; estimated_cost: number }>;
  }

  // ── Security events ──

  logSecurityEvent(eventType: string, userId: string | null, userName: string | null, channelId: string | null, messageText: string | null, details?: string): void {
    this.db
      .prepare(
        `INSERT INTO security_events (event_type, user_id, user_name, channel_id, message_text, details)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(eventType, userId, userName, channelId, messageText, details || null);
  }

  getSecurityEvents(limit = 100): SecurityEvent[] {
    return this.db
      .prepare(
        `SELECT * FROM security_events ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as SecurityEvent[];
  }

  // ── Dashboard queries ──

  getAllRequests(page = 1, limit = 20, status?: string, from?: string, to?: string): { rows: ComcheckRequest[]; total: number } {
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (status) {
      where += ' AND status = ?';
      params.push(status);
    }
    if (from) {
      where += ' AND created_at >= ?';
      params.push(from);
    }
    if (to) {
      where += ' AND created_at <= ?';
      params.push(to);
    }

    const total = (this.db
      .prepare(`SELECT COUNT(*) as count FROM comcheck_requests ${where}`)
      .get(...params) as { count: number }).count;

    const offset = (page - 1) * limit;
    const rows = this.db
      .prepare(`SELECT * FROM comcheck_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ComcheckRequest[];

    return { rows, total };
  }

  getComchecksByDay(days = 30): Array<{ date: string; count: number; total_amount: number }> {
    return this.db
      .prepare(
        `SELECT date(created_at) as date,
                COUNT(*) as count,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) as total_amount
         FROM comcheck_requests
         WHERE created_at >= date('now', '-' || ? || ' days')
         GROUP BY date(created_at)
         ORDER BY date ASC`
      )
      .all(days) as Array<{ date: string; count: number; total_amount: number }>;
  }

  getComchecksByDispatcher(): Array<{ dispatcher: string; count: number }> {
    return this.db
      .prepare(
        `SELECT slack_user_name as dispatcher, COUNT(*) as count
         FROM comcheck_requests
         WHERE status = 'completed'
         GROUP BY slack_user_name
         ORDER BY count DESC`
      )
      .all() as Array<{ dispatcher: string; count: number }>;
  }

  getConversations(limit = 50): ConversationSummary[] {
    return this.db
      .prepare(
        `SELECT
           c.thread_id,
           MIN(c.created_at) as first_message_at,
           MAX(c.created_at) as last_message_at,
           COUNT(*) as message_count,
           EXISTS(SELECT 1 FROM comcheck_requests r WHERE r.slack_thread_ts = c.thread_id AND r.status = 'completed') as resulted_in_comcheck
         FROM conversations c
         GROUP BY c.thread_id
         ORDER BY last_message_at DESC
         LIMIT ?`
      )
      .all(limit) as ConversationSummary[];
  }

  getMonthlyStats(): { total: number; completed: number; failed: number; total_amount: number } {
    return this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) as total_amount
         FROM comcheck_requests
         WHERE created_at >= date('now', '-30 days')`
      )
      .get() as { total: number; completed: number; failed: number; total_amount: number };
  }

  getAllTimeStats(): { total: number; completed: number; failed: number; total_amount: number } {
    return this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) as total_amount
         FROM comcheck_requests`
      )
      .get() as { total: number; completed: number; failed: number; total_amount: number };
  }

  close(): void {
    this.db.close();
  }
}

export interface TokenPeriod {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  request_count: number;
}

export interface SecurityEvent {
  id: number;
  event_type: string;
  user_id: string | null;
  user_name: string | null;
  channel_id: string | null;
  message_text: string | null;
  details: string | null;
  created_at: string;
}

export interface ConversationSummary {
  thread_id: string;
  first_message_at: string;
  last_message_at: string;
  message_count: number;
  resulted_in_comcheck: number;
}

export interface AuditEntry {
  id: number;
  request_id: string;
  old_status: string | null;
  new_status: string;
  triggered_by: string;
  timestamp: string;
  details: string | null;
}
