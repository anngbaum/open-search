import fs from 'fs';
import path from 'path';
import { copyDb } from './copy-db.js';
import { ingest } from './ingest.js';
import { embed } from './embed.js';
import { updateMetadata } from './update-metadata.js';
import { getPglite, closePglite, initSchema } from '../db/pglite-client.js';
import { DATA_DIR } from '../config.js';

const PG_DATA_DIR = path.join(DATA_DIR, 'pgdata');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

function loadSettings(): { anthropicApiKey?: string; openaiApiKey?: string; selectedModel?: string } {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

export interface ResyncOptions {
  metadataOnly?: boolean;
  batchSize?: number;
  short?: boolean;
}

interface SavedAction {
  chat_id: number;
  created_at: string;
  due_date: string | null;
  action_descriptor: string;
  completed: boolean;
  message_id: number | null;
}

async function backupCompletedActions(): Promise<SavedAction[]> {
  try {
    const db = await getPglite();
    const result = await db.query(
      'SELECT chat_id, created_at, due_date, action_descriptor, completed, message_id FROM actions_needed WHERE completed = true'
    );
    return result.rows as SavedAction[];
  } catch {
    return [];
  }
}

async function restoreCompletedActions(actions: SavedAction[]): Promise<void> {
  if (actions.length === 0) return;
  const db = await getPglite();
  for (const a of actions) {
    await db.query(
      `INSERT INTO actions_needed (chat_id, created_at, due_date, action_descriptor, completed, message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [a.chat_id, a.created_at, a.due_date, a.action_descriptor, a.completed, a.message_id]
    );
  }
  console.log(`  Restored ${actions.length} completed action(s).`);
}

export async function resync(options: ResyncOptions = {}): Promise<void> {
  if (!options.metadataOnly) {
    // 0. Back up completed actions before wiping
    const completedActions = await backupCompletedActions();

    // 1. Wipe PGLite data (not the source chat.db)
    if (fs.existsSync(PG_DATA_DIR)) {
      console.log('Wiping local PGLite database...');
      fs.rmSync(PG_DATA_DIR, { recursive: true, force: true });
      console.log('  Done.');
    }

    // Reset the cached PGLite client since we just deleted its data
    await closePglite();

    // 2. Copy fresh chat.db
    console.log('Copying fresh chat.db...');
    await copyDb({ force: true });

    // 3. Ingest messages
    const months = options.short ? 0.25 : 6;
    const label = options.short ? '1 week' : '6 months';
    console.log(`Ingesting last ${label} of messages...`);
    await ingest({ months });

    // 4. Restore completed actions so they aren't recreated
    await restoreCompletedActions(completedActions);

    // 5. Embed all messages
    console.log('\nStarting embedding...');
    await embed({ batchSize: options.batchSize ?? 200 });
  }

  // 5. Summarize chats active in the last 14 days (with >1 message)
  // Check if server is running — warn user to stop it to avoid PGLite conflicts
  try {
    await fetch('http://localhost:11488/api/settings');
    console.warn('\nWarning: Server is running. Stop it before resync to avoid DB conflicts.');
    console.warn('  Run: kill $(lsof -ti :11488) && npm run resync -- --metadata-only\n');
  } catch {
    // Server not running — good
  }

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  console.log('\nUpdating chat metadata for recent conversations...');
  const settings = loadSettings();
  const llmConfig = {
    model: settings.selectedModel ?? 'claude-haiku-4-5-20251001',
    anthropicApiKey: settings.anthropicApiKey,
    openaiApiKey: settings.openaiApiKey,
  };
  await updateMetadata(llmConfig, { since: fourteenDaysAgo, minMessages: 2 });

  console.log('\nResync complete!');
}
