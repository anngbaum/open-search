import Database from 'better-sqlite3';
import path from 'path';
import { DATA_DIR } from '../config.js';

const DB_PATH = path.join(DATA_DIR, 'chat.db');

const REQUIRED_TABLES = ['message', 'handle', 'chat', 'chat_message_join', 'chat_handle_join'];

export function openSqlite(): Database.Database {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export function verifySqliteTables(db: Database.Database): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  const tableNames = new Set(tables.map((t) => t.name));

  const missing = REQUIRED_TABLES.filter((t) => !tableNames.has(t));
  if (missing.length > 0) {
    throw new Error(
      `chat.db is missing required tables: ${missing.join(', ')}. ` +
        'This may not be a valid iMessage database.'
    );
  }
}

export function getMessageCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM message').get() as { count: number };
  return row.count;
}

export function getHandleCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM handle').get() as { count: number };
  return row.count;
}

export function getChatCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM chat').get() as { count: number };
  return row.count;
}
