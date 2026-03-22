import fs from 'fs';
import path from 'path';
import { openSqlite, verifySqliteTables } from '../db/sqlite-reader.js';
import { getPglite, closePglite, initSchema } from '../db/pglite-client.js';
import { copyDb } from './copy-db.js';
import {
  extractHandles,
  extractChats,
  extractMessagesBatched,
  extractChatMessageJoins,
  extractChatHandleJoins,
} from '../etl/extract.js';
import { transformMessages } from '../etl/transform.js';
import {
  loadHandles,
  loadChats,
  loadMessages,
  loadChatMessageJoins,
  loadChatHandleJoins,
  loadLinkPreviews,
  populateTextSearch,
} from '../etl/load.js';
import { extractLinkPreviewRows, transformLinkPreviews } from '../etl/link-preview.js';
import { buildContactMap, resolveHandle } from '../contacts/address-book.js';
import { embed } from './embed.js';
import { updateMetadata } from './update-metadata.js';
import type { LLMConfig } from '../llm/query-parser.js';
import { DATA_DIR } from '../config.js';

const PG_DATA_DIR = path.join(DATA_DIR, 'pgdata');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

export interface UnifiedSyncOptions {
  /** Wipe pgdata and do a full re-ingest + embed + metadata from scratch */
  hardReset?: boolean;
  /** Skip embedding step */
  skipEmbed?: boolean;
  /** Skip metadata/actions update */
  skipMetadata?: boolean;
  /** Embedding batch size */
  embedBatchSize?: number;
  /** LLM config for metadata — if omitted, loads from settings.json */
  llmConfig?: LLMConfig;
}

export interface UnifiedSyncResult {
  messagesAdded: number;
  handlesAdded: number;
  lastSynced: string;
  wasHardReset: boolean;
}

interface SavedAction {
  chat_id: number;
  created_at: string;
  due_date: string | null;
  action_descriptor: string;
  completed: boolean;
  message_id: number | null;
}

function loadSettings(): { anthropicApiKey?: string; openaiApiKey?: string; selectedModel?: string } {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function getLLMConfig(options: UnifiedSyncOptions): LLMConfig {
  if (options.llmConfig) return options.llmConfig;
  const s = loadSettings();
  return {
    model: s.selectedModel ?? 'claude-haiku-4-5-20251001',
    anthropicApiKey: s.anthropicApiKey,
    openaiApiKey: s.openaiApiKey,
  };
}

export async function getLastSynced(pg: import('@electric-sql/pglite').PGlite): Promise<Date | null> {
  const result = await pg.query('SELECT last_synced FROM sync_meta WHERE id = 1');
  if (result.rows.length === 0) return null;
  return new Date((result.rows[0] as { last_synced: string }).last_synced);
}

async function setLastSynced(pg: import('@electric-sql/pglite').PGlite, date: Date): Promise<void> {
  await pg.query(
    `INSERT INTO sync_meta (id, last_synced) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_synced = $1`,
    [date.toISOString()]
  );
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

/**
 * Core ETL: extract from SQLite, transform, and load into PGLite.
 * Used by both incremental sync and hard reset.
 */
async function runETL(afterDate?: Date): Promise<{ messagesAdded: number; handlesAdded: number }> {
  const sqlite = openSqlite();
  verifySqliteTables(sqlite);
  const pg = await getPglite();

  // Handles (with contact resolution)
  console.log('Syncing handles...');
  const contactMap = await buildContactMap();
  const handles = extractHandles(sqlite);
  let resolvedCount = 0;
  for (const handle of handles) {
    const displayName = resolveHandle(handle.identifier, contactMap);
    handle.display_name = displayName;
    if (displayName) resolvedCount++;
  }
  const handleCount = await loadHandles(pg, handles);
  console.log(`  Loaded ${handleCount} handles (${resolvedCount} with contact names)`);

  // Chats
  console.log('Syncing chats...');
  const chats = extractChats(sqlite);
  await loadChats(pg, chats);

  // Messages
  const dateLabel = afterDate
    ? `since ${afterDate.toISOString().split('T')[0]}`
    : '(all messages)';
  console.log(`Extracting messages ${dateLabel}...`);
  let totalMessages = 0;
  const batchGen = extractMessagesBatched(sqlite, 5000, afterDate);
  for (const rawBatch of batchGen) {
    const transformed = transformMessages(rawBatch);
    const loaded = await loadMessages(pg, transformed);
    totalMessages += loaded;
    process.stdout.write(`  Loaded ${totalMessages} messages\r`);
  }
  console.log(`  Loaded ${totalMessages} messages total`);

  // Join tables
  console.log('Syncing join tables...');
  const cmJoins = extractChatMessageJoins(sqlite, afterDate);
  await loadChatMessageJoins(pg, cmJoins);
  const chJoins = extractChatHandleJoins(sqlite);
  await loadChatHandleJoins(pg, chJoins);

  // Link previews
  console.log('Extracting link previews...');
  const linkRows = extractLinkPreviewRows(sqlite, afterDate);
  const linkPreviews = transformLinkPreviews(linkRows);
  const linkCount = await loadLinkPreviews(pg, linkPreviews);
  console.log(`  Loaded ${linkCount} link previews`);

  // Full-text search
  console.log('Updating text search index...');
  const ftsCount = await populateTextSearch(pg);
  console.log(`  Indexed ${ftsCount} messages for full-text search`);

  sqlite.close();
  return { messagesAdded: totalMessages, handlesAdded: handleCount };
}

export async function unifiedSync(options: UnifiedSyncOptions = {}): Promise<UnifiedSyncResult> {
  const { hardReset = false, skipEmbed = false, skipMetadata = false, embedBatchSize = 200 } = options;

  if (hardReset) {
    // --- Hard reset: wipe and rebuild from scratch ---
    console.log('=== Hard Reset ===');

    // Backup completed actions
    const completedActions = await backupCompletedActions();

    // Wipe pgdata
    if (fs.existsSync(PG_DATA_DIR)) {
      console.log('Wiping PGLite database...');
      await closePglite();
      fs.rmSync(PG_DATA_DIR, { recursive: true, force: true });
    }

    // Copy fresh chat.db
    console.log('Copying fresh chat.db...');
    await copyDb({ force: true });

    // Init fresh PGLite
    const pg = await getPglite();
    await initSchema();

    // Full ingest (no date filter = all messages)
    const etlResult = await runETL();

    // Restore completed actions
    await restoreCompletedActions(completedActions);

    // Embed all
    if (!skipEmbed) {
      console.log('\nEmbedding messages...');
      await embed({ batchSize: embedBatchSize });
    }

    // Update metadata for recent conversations
    if (!skipMetadata) {
      const llmConfig = getLLMConfig(options);
      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      console.log('\nUpdating chat metadata...');
      await updateMetadata(llmConfig, { since: fourteenDaysAgo, minMessages: 2 });
    }

    const now = new Date();
    await setLastSynced(pg, now);

    console.log('\nHard reset complete!');
    return {
      messagesAdded: etlResult.messagesAdded,
      handlesAdded: etlResult.handlesAdded,
      lastSynced: now.toISOString(),
      wasHardReset: true,
    };
  }

  // --- Incremental sync ---
  console.log('Copying fresh chat.db...');
  await copyDb({ force: true });

  const pg = await getPglite();
  await initSchema();

  const lastSynced = await getLastSynced(pg);
  const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const afterDate = lastSynced ?? threeMonthsAgo;
  console.log(lastSynced
    ? `Last synced: ${lastSynced.toISOString()}`
    : 'No previous sync — importing last 3 months'
  );

  const etlResult = await runETL(afterDate);

  const now = new Date();
  await setLastSynced(pg, now);

  // Embed new messages
  if (!skipEmbed) {
    console.log('Embedding new messages...');
    await embed({ batchSize: embedBatchSize });
  }

  // Update metadata/actions — always re-check at least the last 7 days
  // so action items are re-evaluated even if the last sync was recent
  if (!skipMetadata) {
    const llmConfig = getLLMConfig(options);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const metadataSince = afterDate < sevenDaysAgo ? afterDate : sevenDaysAgo;
    console.log('Updating metadata for conversations active in the last 7 days...');
    await updateMetadata(llmConfig, { since: metadataSince, minMessages: 1 });
  }

  console.log('\nSync complete!');
  return {
    messagesAdded: etlResult.messagesAdded,
    handlesAdded: etlResult.handlesAdded,
    lastSynced: now.toISOString(),
    wasHardReset: false,
  };
}
