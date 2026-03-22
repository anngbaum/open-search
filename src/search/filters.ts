import type { SearchOptions, SearchResult } from '../types.js';

export interface FilterResult {
  clauses: string[];
  params: unknown[];
  paramIndex: number;
}

export function buildFilters(
  options: SearchOptions,
  startParamIndex: number = 1
): FilterResult {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = startParamIndex;

  if (options.handleIds && options.handleIds.length > 0) {
    const placeholders = options.handleIds.map((_, i) => `$${idx + i}`).join(', ');
    clauses.push(`m.handle_id IN (${placeholders})`);
    params.push(...options.handleIds);
    idx += options.handleIds.length;
  } else if (options.from) {
    clauses.push(`(h.identifier ILIKE $${idx} OR h.display_name ILIKE $${idx})`);
    params.push(`%${options.from}%`);
    idx++;
  }

  if (options.withContacts && options.withContacts.length > 0) {
    for (const contact of options.withContacts) {
      clauses.push(`EXISTS (
        SELECT 1 FROM chat_message_join _wcmj
        JOIN chat_handle_join _wchj ON _wcmj.chat_id = _wchj.chat_id
        JOIN handle _wh ON _wchj.handle_id = _wh.id
        WHERE _wcmj.message_id = m.id
        AND (_wh.identifier ILIKE $${idx} OR _wh.display_name ILIKE $${idx})
      )`);
      params.push(`%${contact}%`);
      idx++;
    }
  }

  if (options.groupChatName) {
    clauses.push(`(c.display_name ILIKE $${idx} OR c.chat_identifier ILIKE $${idx})`);
    params.push(`%${options.groupChatName}%`);
    idx++;
  }

  if (options.after) {
    clauses.push(`m.date >= $${idx}::timestamptz`);
    params.push(options.after);
    idx++;
  }

  if (options.before) {
    clauses.push(`m.date <= $${idx}::timestamptz`);
    params.push(options.before);
    idx++;
  }

  if (options.fromMe) {
    clauses.push('m.is_from_me = true');
  }

  if (options.toMe) {
    clauses.push('m.is_from_me = false');
  }

  return { clauses, params, paramIndex: idx };
}

/**
 * SQL expression that resolves a chat display name:
 * - Named chats: use display_name
 * - Unnamed group chats (>1 participant): "chat with A, B, C" (up to 6, then "and N others")
 * - 1:1 chats, sent by me: "to ContactName"
 * - 1:1 chats, received: NULL (sender already shown)
 */
export function chatDisplayExpression(chatAlias: string): string {
  return `CASE
    WHEN ${chatAlias}.display_name IS NOT NULL AND ${chatAlias}.display_name != '' THEN ${chatAlias}.display_name
    WHEN (SELECT COUNT(*) FROM chat_handle_join _chj WHERE _chj.chat_id = ${chatAlias}.id) > 1 THEN
      'chat with ' || (
        SELECT string_agg(_sub.name, ', ')
        FROM (
          SELECT COALESCE(_h.display_name, _h.identifier) as name
          FROM chat_handle_join _chj2
          JOIN handle _h ON _chj2.handle_id = _h.id
          WHERE _chj2.chat_id = ${chatAlias}.id
          ORDER BY _h.id
          LIMIT 6
        ) _sub
      ) || CASE
        WHEN (SELECT COUNT(*) FROM chat_handle_join _chj3 WHERE _chj3.chat_id = ${chatAlias}.id) > 6
        THEN ' and ' || ((SELECT COUNT(*) FROM chat_handle_join _chj4 WHERE _chj4.chat_id = ${chatAlias}.id) - 6) || ' others'
        ELSE ''
      END
    WHEN m.is_from_me THEN
      'to ' || (
        SELECT COALESCE(_h2.display_name, _h2.identifier)
        FROM chat_handle_join _chj5
        JOIN handle _h2 ON _chj5.handle_id = _h2.id
        WHERE _chj5.chat_id = ${chatAlias}.id
        LIMIT 1
      )
    ELSE NULL
  END`;
}

export interface RawSearchRow {
  id: number;
  text: string;
  date: Date | null;
  is_from_me: boolean;
  sender: string | null;
  chat_name: string | null;
  score: number;
  lp_original_url: string | null;
  lp_canonical_url: string | null;
  lp_title: string | null;
  lp_summary: string | null;
  lp_item_type: string | null;
  lp_author: string | null;
}

export function formatSearchRow(row: RawSearchRow): SearchResult {
  return {
    id: row.id,
    text: row.text,
    date: row.date,
    is_from_me: row.is_from_me,
    sender: row.sender,
    chat_name: row.chat_name,
    score: row.score,
    link_preview: row.lp_original_url ? {
      original_url: row.lp_original_url,
      canonical_url: row.lp_canonical_url,
      title: row.lp_title,
      summary: row.lp_summary,
      item_type: row.lp_item_type,
      author: row.lp_author,
    } : null,
  };
}

export function buildJoinClause(options: SearchOptions): string {
  const joins: string[] = [];

  if (options.from || options.toMe || options.fromMe || options.handleIds) {
    joins.push('LEFT JOIN handle h ON m.handle_id = h.id');
  }

  if (options.groupChatName) {
    joins.push('LEFT JOIN chat_message_join cmj ON m.id = cmj.message_id');
    joins.push('LEFT JOIN chat c ON cmj.chat_id = c.id');
  }

  return joins.join('\n');
}
