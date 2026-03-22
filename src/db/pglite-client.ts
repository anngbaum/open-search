import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';

const PG_DATA_DIR = path.join(DATA_DIR, 'pgdata');
const SCHEMA_PATH = path.join(import.meta.dirname, 'schema.sql');

let client: PGlite | null = null;

export async function getPglite(): Promise<PGlite> {
  if (client) return client;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  client = new PGlite(PG_DATA_DIR, {
    extensions: { vector },
  });

  await client.waitReady;

  return client;
}

export async function initSchema(): Promise<void> {
  const db = await getPglite();
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');

  // Split on semicolons and execute each statement
  const statements = schema
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await db.exec(stmt + ';');
  }

  // Migrations for existing databases
  try {
    await db.exec('ALTER TABLE actions_needed ADD COLUMN IF NOT EXISTS message_id INTEGER;');
  } catch {
    // Column already exists
  }
}

export async function closePglite(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch {
      // Client may already be closing or its data dir was removed
    }
    client = null;
  }
}
