import { getPglite } from '../db/pglite-client.js';
import { getEmbedding } from '../embeddings/local.js';
import type { SearchResult, SearchOptions } from '../types.js';
import { buildFilters, buildJoinClause, chatDisplayExpression, formatSearchRow, type RawSearchRow } from './filters.js';

export async function searchVector(
  query: string,
  options: SearchOptions
): Promise<SearchResult[]> {
  const db = await getPglite();

  // Get embedding for the query
  const queryEmbedding = await getEmbedding(query);

  const joins = buildJoinClause(options);
  const { clauses, params, paramIndex } = buildFilters(options, 2);

  // Add mandatory filters
  clauses.push('m.embedding IS NOT NULL');
  clauses.push('m.embedding_skipped = false');
  clauses.push('m.text IS NOT NULL');
  clauses.push('m.associated_message_type = 0');

  const needsHandleJoin = !joins.includes('handle h');
  const handleJoin = needsHandleJoin ? 'LEFT JOIN handle h ON m.handle_id = h.id' : '';

  const needsChatJoin = !joins.includes('chat c');
  const chatJoin = needsChatJoin
    ? `LEFT JOIN chat_message_join cmj2 ON m.id = cmj2.message_id
       LEFT JOIN chat c2 ON cmj2.chat_id = c2.id`
    : '';
  const chatAlias = needsChatJoin ? 'c2' : 'c';
  const chatDisplayCol = chatDisplayExpression(chatAlias);

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  const MIN_SCORE = 0.5;

  const sql = `
    SELECT * FROM (
      SELECT DISTINCT ON (m.id)
        m.id, m.text, m.date, m.is_from_me,
        COALESCE(h.display_name, h.identifier) as sender,
        ${chatDisplayCol} as chat_name,
        1 - (m.embedding <=> $1::vector) as score,
        lp.original_url as lp_original_url,
        lp.canonical_url as lp_canonical_url,
        lp.title as lp_title,
        lp.summary as lp_summary,
        lp.item_type as lp_item_type,
        lp.author as lp_author
      FROM message m
      ${joins}
      ${handleJoin}
      ${chatJoin}
      LEFT JOIN link_preview lp ON lp.message_id = m.id
      ${whereClause}
      ORDER BY m.id, score DESC
    ) sub
    WHERE sub.score >= ${MIN_SCORE}
    ORDER BY sub.score DESC
    LIMIT $${paramIndex}
    OFFSET $${paramIndex + 1}
  `;

  const allParams = [embeddingStr, ...params, options.limit, options.offset];

  const result = await db.query(sql, allParams);

  const rows = (result.rows as RawSearchRow[]).sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateB - dateA;
  });
  return rows.map(formatSearchRow);
}
