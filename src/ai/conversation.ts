import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const DB_DIR = path.resolve('./data');
const DB_PATH = path.join(DB_DIR, 'browser-ai.db');

// Sliding window: keep last N messages per thread
const MAX_MESSAGES_PER_THREAD = 20;
// Clear conversations older than 24 hours
const TTL_MS = 24 * 60 * 60 * 1000;

export class ConversationManager {
  private db: Database.Database;

  constructor() {
    fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.createTable();
  }

  private createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_thread
      ON conversations(thread_id, created_at)
    `);
  }

  addMessage(threadId: string, role: 'user' | 'assistant', content: string): void {
    this.db
      .prepare('INSERT INTO conversations (thread_id, role, content) VALUES (?, ?, ?)')
      .run(threadId, role, content);

    // Enforce sliding window — delete oldest messages beyond the limit
    this.db
      .prepare(
        `DELETE FROM conversations WHERE thread_id = ? AND id NOT IN (
          SELECT id FROM conversations WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?
        )`
      )
      .run(threadId, threadId, MAX_MESSAGES_PER_THREAD);
  }

  getHistory(threadId: string): Anthropic.MessageParam[] {
    const rows = this.db
      .prepare(
        'SELECT role, content FROM conversations WHERE thread_id = ? ORDER BY created_at ASC'
      )
      .all(threadId) as Array<{ role: string; content: string }>;

    return rows.map((row) => ({
      role: row.role as 'user' | 'assistant',
      content: row.content,
    }));
  }

  clearThread(threadId: string): void {
    this.db.prepare('DELETE FROM conversations WHERE thread_id = ?').run(threadId);
  }

  /** Remove conversations older than 24 hours */
  cleanupExpired(): void {
    const cutoff = new Date(Date.now() - TTL_MS).toISOString();
    this.db
      .prepare("DELETE FROM conversations WHERE created_at < ?")
      .run(cutoff);
  }

  close(): void {
    this.db.close();
  }
}
