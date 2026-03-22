import type { SearchResult, ContextMessage } from '../types.js';
import { getPglite } from '../db/pglite-client.js';

function formatDate(date: Date | string | null): string {
  if (!date) return 'unknown date';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function truncate(text: string, maxLen: number = 200): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

export function formatSearchResults(results: SearchResult[], mode: string): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [];
  lines.push(`Found ${results.length} result(s) [${mode} search]:\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const sender = r.is_from_me ? 'Me' : (r.sender || 'Unknown');
    const chatLabel = r.chat_name ? ` in "${r.chat_name}"` : '';
    const dateStr = formatDate(r.date);
    const scoreStr = typeof r.score === 'number' ? ` (score: ${r.score.toFixed(4)})` : '';

    lines.push(`${i + 1}. [${dateStr}] ${sender}${chatLabel}${scoreStr}`);
    lines.push(`   ${truncate(r.text || '(no text)')}`);
    lines.push('');
  }

  return lines.join('\n');
}

export async function getContextMessages(
  messageId: number,
  beforeCount: number,
  afterCount: number
): Promise<ContextMessage[]> {
  if (beforeCount <= 0 && afterCount <= 0) return [];

  try {
    const db = await getPglite();

    // Get the chat this message belongs to
    const chatResult = await db.query(
      `SELECT chat_id FROM chat_message_join WHERE message_id = $1 LIMIT 1`,
      [messageId]
    );

    if (chatResult.rows.length === 0) return [];

    const chatId = (chatResult.rows[0] as { chat_id: number }).chat_id;

    // Compute the ID range in JS to avoid SQL arithmetic issues
    const total = beforeCount + afterCount;
    const idRange = total * 10;
    const minId = messageId - idRange;
    const maxId = messageId + idRange;

    // Get surrounding messages in the same chat
    const result = await db.query(
      `SELECT m.id, m.text, m.date, m.is_from_me, COALESCE(h.display_name, h.identifier) as sender
       FROM message m
       JOIN chat_message_join cmj ON m.id = cmj.message_id
       LEFT JOIN handle h ON m.handle_id = h.id
       WHERE cmj.chat_id = $1
         AND m.id >= $2 AND m.id <= $3
         AND m.id != $4
         AND m.associated_message_type = 0
       ORDER BY m.date
       LIMIT $5`,
      [chatId, minId, maxId, messageId, total * 2 + 10]
    );

    const rows = result.rows as ContextMessage[];

    // Split into before and after the target message
    const idx = rows.findIndex((r) => r.id > messageId);
    if (idx === -1) {
      // All messages are before our target
      return rows.slice(-beforeCount);
    }
    const before = rows.slice(Math.max(0, idx - beforeCount), idx);
    const after = rows.slice(idx, idx + afterCount);

    return [...before, ...after];
  } catch {
    // Context is non-critical — don't crash if it fails
    return [];
  }
}

export function formatContextMessages(messages: ContextMessage[]): string {
  if (messages.length === 0) return '';

  const lines = messages.map((m) => {
    const sender = m.is_from_me ? 'Me' : (m.sender || 'Unknown');
    const dateStr = formatDate(m.date);
    return `     [${dateStr}] ${sender}: ${truncate(m.text || '(no text)', 100)}`;
  });

  return '   Context:\n' + lines.join('\n');
}
