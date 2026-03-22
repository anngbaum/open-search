import type Database from 'better-sqlite3';
import type { LinkPreview } from '../types.js';
import { decodeLinkPayload } from '../parsers/link-preview.js';

const APPLE_EPOCH_OFFSET = 978307200;
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/;

interface RawLinkPreviewRow {
  message_id: number;
  payload_data: Buffer | null;
  attributedBody: Buffer | null;
}

/**
 * Extract URL from attributedBody blob when payload_data is unavailable.
 * The URL is embedded as the string content of the NSAttributedString.
 */
function extractUrlFromAttributedBody(blob: Buffer | null): string | null {
  if (!blob || blob.length === 0) return null;
  try {
    const buf = Buffer.from(blob);
    const nsStringIdx = buf.indexOf('NSString');
    if (nsStringIdx === -1) return null;

    const searchStart = nsStringIdx + 8;
    const searchEnd = Math.min(searchStart + 40, buf.length - 2);

    for (let i = searchStart; i < searchEnd; i++) {
      if (buf[i] !== 0x01) continue;
      const tag = buf[i + 1];

      let text: string | null = null;
      if (tag === 0x2b) {
        const len = buf[i + 2];
        if (i + 3 + len <= buf.length) {
          text = buf.subarray(i + 3, i + 3 + len).toString('utf-8');
        }
      } else if (tag === 0x69) {
        if (i + 6 <= buf.length) {
          const len = buf.readUInt32BE(i + 2);
          if (i + 6 + len <= buf.length) {
            text = buf.subarray(i + 6, i + 6 + len).toString('utf-8');
          }
        }
      }

      if (text) {
        const match = text.match(URL_REGEX);
        if (match) return match[0];
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract raw link preview rows from SQLite.
 * Queries messages with balloon_bundle_id = 'com.apple.messages.URLBalloonProvider'.
 */
export function extractLinkPreviewRows(
  db: Database.Database,
  afterDate?: Date
): RawLinkPreviewRow[] {
  let whereExtra = '';
  if (afterDate) {
    const nano = (afterDate.getTime() / 1000 - APPLE_EPOCH_OFFSET) * 1e9;
    whereExtra = ` AND date >= ${nano}`;
  }

  return db
    .prepare(
      `SELECT ROWID as message_id, payload_data, attributedBody
       FROM message
       WHERE balloon_bundle_id = 'com.apple.messages.URLBalloonProvider'
       ${whereExtra}
       ORDER BY ROWID`
    )
    .all() as RawLinkPreviewRow[];
}

/**
 * Transform raw rows into LinkPreview objects.
 * Primary: decode payload_data bplist. Fallback: extract URL from attributedBody.
 */
export function transformLinkPreviews(rows: RawLinkPreviewRow[]): LinkPreview[] {
  const results: LinkPreview[] = [];

  for (const row of rows) {
    let preview: LinkPreview | null = null;

    if (row.payload_data) {
      const decoded = decodeLinkPayload(row.payload_data);
      if (decoded?.originalURL) {
        preview = {
          message_id: row.message_id,
          original_url: decoded.originalURL,
          canonical_url: decoded.canonicalURL,
          title: decoded.title,
          summary: decoded.summary,
          item_type: decoded.itemType,
          author: decoded.author,
        };
      }
    }

    if (!preview) {
      const url = extractUrlFromAttributedBody(row.attributedBody);
      if (url) {
        preview = {
          message_id: row.message_id,
          original_url: url,
          canonical_url: null,
          title: null,
          summary: null,
          item_type: null,
          author: null,
        };
      }
    }

    if (preview) {
      results.push(preview);
    }
  }

  return results;
}
