import { getPglite } from '../db/pglite-client.js';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';

export async function status(): Promise<void> {
  const chatDbPath = path.join(DATA_DIR, 'chat.db');

  console.log('=== Open-Search Status ===\n');

  // Check chat.db copy
  if (fs.existsSync(chatDbPath)) {
    const stat = fs.statSync(chatDbPath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    const modified = stat.mtime.toLocaleString();
    console.log(`chat.db: ${sizeMB} MB (copied: ${modified})`);
  } else {
    console.log('chat.db: Not found. Run "open-search copy-db" first.');
    return;
  }

  // Check PGLite
  const pgDir = path.join(DATA_DIR, 'pgdata');
  if (!fs.existsSync(pgDir)) {
    console.log('PGLite: Not initialized. Run "open-search ingest" first.');
    return;
  }

  try {
    const db = await getPglite();

    const handleCount = await db.query('SELECT COUNT(*) as count FROM handle');
    const resolvedHandles = await db.query(
      'SELECT COUNT(*) as count FROM handle WHERE display_name IS NOT NULL'
    );
    const chatCount = await db.query('SELECT COUNT(*) as count FROM chat');
    const messageCount = await db.query('SELECT COUNT(*) as count FROM message');
    const textMessages = await db.query(
      "SELECT COUNT(*) as count FROM message WHERE text IS NOT NULL AND text != ''"
    );
    const embeddedCount = await db.query(
      'SELECT COUNT(*) as count FROM message WHERE embedding IS NOT NULL'
    );
    const ftsCount = await db.query(
      'SELECT COUNT(*) as count FROM message WHERE text_search IS NOT NULL'
    );

    const row = (r: { rows: unknown[] }) =>
      Number((r.rows[0] as { count: number }).count);

    console.log(`\nPGLite Database:`);
    const totalHandles = row(handleCount);
    const resolvedCount = row(resolvedHandles);
    const resolvedPct = totalHandles > 0 ? ((resolvedCount / totalHandles) * 100).toFixed(1) : '0.0';
    console.log(`  Handles:          ${totalHandles.toLocaleString()} (${resolvedCount.toLocaleString()} with contact names, ${resolvedPct}%)`);
    console.log(`  Chats:            ${row(chatCount).toLocaleString()}`);
    console.log(`  Messages:         ${row(messageCount).toLocaleString()}`);
    const textCount = row(textMessages);
    const embedCount = row(embeddedCount);
    const embedPct = textCount > 0 ? ((embedCount / textCount) * 100).toFixed(1) : '0.0';

    console.log(`  With text:        ${textCount.toLocaleString()}`);
    console.log(`  FTS indexed:      ${row(ftsCount).toLocaleString()}`);
    console.log(`  With embeddings:  ${embedCount.toLocaleString()} (${embedPct}% of text messages)`);

    // Last synced
    const syncMeta = await db.query('SELECT last_synced FROM sync_meta WHERE id = 1');
    if (syncMeta.rows.length > 0) {
      const lastSynced = new Date((syncMeta.rows[0] as { last_synced: string }).last_synced);
      console.log(`  Last synced:      ${lastSynced.toLocaleString()}`);
    } else {
      console.log(`  Last synced:      Never`);
    }

    // Date range
    const dateRange = await db.query(
      'SELECT MIN(date) as earliest, MAX(date) as latest FROM message WHERE date IS NOT NULL'
    );
    if (dateRange.rows.length > 0) {
      const dr = dateRange.rows[0] as { earliest: string; latest: string };
      if (dr.earliest && dr.latest) {
        console.log(
          `  Date range:       ${new Date(dr.earliest).toLocaleDateString()} — ${new Date(dr.latest).toLocaleDateString()}`
        );
      }
    }
  } catch (err) {
    console.error('Error reading PGLite:', err);
  }
}
