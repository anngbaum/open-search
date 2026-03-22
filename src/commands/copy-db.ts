import fs from 'fs';
import path from 'path';
import os from 'os';
import { DATA_DIR } from '../config.js';

const SOURCE_DIR = path.join(os.homedir(), 'Library', 'Messages');
const SOURCE_DB = path.join(SOURCE_DIR, 'chat.db');
const DEST_DB = path.join(DATA_DIR, 'chat.db');

export async function copyDb(options: { force?: boolean }): Promise<void> {
  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Check if already copied
  if (fs.existsSync(DEST_DB) && !options.force) {
    const srcStat = fs.statSync(SOURCE_DB);
    const destStat = fs.statSync(DEST_DB);
    if (destStat.mtimeMs >= srcStat.mtimeMs) {
      console.log('chat.db is already up to date. Use --force to re-copy.');
      return;
    }
    console.log('Source database is newer, copying...');
  }

  try {
    // Copy main database file
    console.log(`Copying ${SOURCE_DB} → ${DEST_DB}`);
    fs.copyFileSync(SOURCE_DB, DEST_DB);

    // Copy WAL and SHM files if they exist (for consistency)
    for (const ext of ['-wal', '-shm']) {
      const src = SOURCE_DB + ext;
      const dest = DEST_DB + ext;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`Copied ${path.basename(src)}`);
      }
    }

    const stat = fs.statSync(DEST_DB);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`Done! Copied ${sizeMB} MB to ./data/chat.db`);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EACCES') {
      console.error('\nPermission denied reading chat.db.');
      console.error('iMessage database requires Full Disk Access for your terminal app.');
      console.error('\nTo grant access:');
      console.error('  1. Open System Settings → Privacy & Security → Full Disk Access');
      console.error('  2. Enable your terminal app (Terminal, iTerm2, etc.)');
      console.error('  3. Restart your terminal and try again');
      process.exit(1);
    }
    throw err;
  }
}
