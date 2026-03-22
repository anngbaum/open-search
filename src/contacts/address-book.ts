/**
 * Read macOS AddressBook databases and build a lookup map
 * from normalized phone/email → display name.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { normalizePhone, normalizeEmail, isEmail } from './normalize.js';

interface AddressBookRow {
  ZFIRSTNAME: string | null;
  ZLASTNAME: string | null;
  ZFULLNUMBER: string | null;
  ZADDRESSNORMALIZED: string | null;
}

function buildDisplayName(first: string | null, last: string | null): string | null {
  const parts = [first?.trim(), last?.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Scan all AddressBook source databases and build a Map<normalizedKey, displayName>.
 */
export async function buildContactMap(): Promise<Map<string, string>> {
  const contactMap = new Map<string, string>();
  const sourcesDir = path.join(
    os.homedir(),
    'Library/Application Support/AddressBook/Sources'
  );

  let dbPaths: string[];
  try {
    if (!fs.existsSync(sourcesDir)) {
      console.warn('Warning: AddressBook Sources directory not found. Contact names will not be resolved.');
      return contactMap;
    }
    const sources = fs.readdirSync(sourcesDir);
    dbPaths = sources
      .map((s) => path.join(sourcesDir, s, 'AddressBook-v22.abcddb'))
      .filter((p) => fs.existsSync(p));
  } catch (err) {
    console.warn('Warning: Could not scan AddressBook directories:', (err as Error).message);
    return contactMap;
  }

  if (dbPaths.length === 0) {
    console.warn('Warning: No AddressBook databases found. Contact names will not be resolved.');
    return contactMap;
  }

  for (const dbPath of dbPaths) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(`
        SELECT r.ZFIRSTNAME, r.ZLASTNAME, p.ZFULLNUMBER, e.ZADDRESSNORMALIZED
        FROM ZABCDRECORD AS r
        LEFT JOIN ZABCDPHONENUMBER AS p ON r.Z_PK = p.ZOWNER
        LEFT JOIN ZABCDEMAILADDRESS AS e ON r.Z_PK = e.ZOWNER
      `).all() as AddressBookRow[];

      for (const row of rows) {
        const name = buildDisplayName(row.ZFIRSTNAME, row.ZLASTNAME);
        if (!name) continue;

        // Index phone number
        if (row.ZFULLNUMBER) {
          const keys = normalizePhone(row.ZFULLNUMBER);
          for (const key of keys) {
            const existing = contactMap.get(key);
            // Prefer names with both first + last
            if (!existing || (name.includes(' ') && !existing.includes(' '))) {
              contactMap.set(key, name);
            }
          }
        }

        // Index email
        if (row.ZADDRESSNORMALIZED) {
          const key = normalizeEmail(row.ZADDRESSNORMALIZED);
          const existing = contactMap.get(key);
          if (!existing || (name.includes(' ') && !existing.includes(' '))) {
            contactMap.set(key, name);
          }
        }
      }

      db.close();
    } catch (err) {
      console.warn(`Warning: Could not read AddressBook at ${dbPath}:`, (err as Error).message);
    }
  }

  return contactMap;
}

/**
 * Resolve an iMessage handle identifier to a display name using the contact map.
 * Returns the display name or null if not found.
 */
export function resolveHandle(
  identifier: string,
  contactMap: Map<string, string>
): string | null {
  if (!identifier || contactMap.size === 0) return null;

  if (isEmail(identifier)) {
    const key = normalizeEmail(identifier);
    return contactMap.get(key) ?? null;
  }

  // Phone: try all normalized variants
  const keys = normalizePhone(identifier);
  for (const key of keys) {
    const name = contactMap.get(key);
    if (name) return name;
  }

  return null;
}
