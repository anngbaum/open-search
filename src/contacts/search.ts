import { getPglite } from '../db/pglite-client.js';

export interface ContactMatch {
  handleId: number;
  identifier: string;
  displayName: string | null;
  score: number;
  messageCount: number;
}

/**
 * Search for contacts by name, returning ranked matches.
 *
 * Scoring priority (highest first):
 *   1.0  — exact match (case-insensitive)
 *   0.9  — display name starts with the search term
 *   0.8  — all search tokens appear in the display name
 *   0.3–0.7 — partial token matches (proportional)
 *   0.2  — identifier substring match only
 *
 * Ties at the same score are broken by message count (most messages first).
 */
export async function searchContacts(
  name: string,
  limit: number = 5,
): Promise<ContactMatch[]> {
  if (!name || !name.trim()) return [];

  const db = await getPglite();
  const normalizedSearch = name.trim().toLowerCase();
  const tokens = normalizedSearch.split(/\s+/).filter(Boolean);

  // Build WHERE clauses that match any individual token against display_name
  // or the full search term against identifier
  const whereParts: string[] = [];
  const params: string[] = [];
  let idx = 1;

  for (const token of tokens) {
    whereParts.push(`LOWER(h.display_name) LIKE $${idx}`);
    params.push(`%${token}%`);
    idx++;
  }

  // Also match against identifier (phone/email)
  whereParts.push(`LOWER(h.identifier) LIKE $${idx}`);
  params.push(`%${normalizedSearch}%`);

  const sql = `
    SELECT
      h.id as handle_id,
      h.identifier,
      h.display_name,
      COUNT(m.id) as message_count
    FROM handle h
    LEFT JOIN message m ON m.handle_id = h.id
    WHERE (${whereParts.join(' OR ')})
    GROUP BY h.id, h.identifier, h.display_name
  `;

  const result = await db.query(sql, params);
  const rows = result.rows as Array<{
    handle_id: number;
    identifier: string;
    display_name: string | null;
    message_count: string | number;
  }>;

  // Score each candidate
  const scored: ContactMatch[] = rows.map((row) => {
    const displayLower = (row.display_name || '').toLowerCase();
    const msgCount =
      typeof row.message_count === 'string'
        ? parseInt(row.message_count, 10)
        : (row.message_count as number);

    let score = 0;

    if (displayLower === normalizedSearch) {
      // Exact match
      score = 1.0;
    } else if (displayLower.startsWith(normalizedSearch)) {
      // Starts with full search term
      score = 0.9;
    } else if (tokens.length > 0) {
      // Count how many tokens appear in the display name
      const matched = tokens.filter((t) => displayLower.includes(t)).length;
      if (matched === tokens.length) {
        // All tokens present
        score = 0.8;
      } else if (matched > 0) {
        // Partial — scale between 0.3 and 0.7
        score = 0.3 + 0.4 * (matched / tokens.length);
      }
    }

    // If display_name didn't match at all, check identifier
    if (score === 0) {
      const idLower = row.identifier.toLowerCase();
      if (idLower.includes(normalizedSearch)) {
        score = 0.2;
      } else {
        // At least one token matched in WHERE so give minimum score
        score = 0.1;
      }
    }

    return {
      handleId: row.handle_id,
      identifier: row.identifier,
      displayName: row.display_name,
      score,
      messageCount: msgCount,
    };
  });

  // Sort: highest score first, then most messages for ties
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.messageCount - a.messageCount;
  });

  return scored.slice(0, limit);
}

/**
 * Resolve a contact name to the best-matching handle IDs.
 *
 * Returns the handle IDs of the top-scoring contact(s). If multiple contacts
 * share the same top score (e.g. same person with phone + email), all are
 * returned so search results include messages from any of their handles.
 */
export async function resolveContactHandleIds(
  name: string,
): Promise<number[]> {
  const matches = await searchContacts(name, 10);
  if (matches.length === 0) return [];

  const topScore = matches[0].score;

  // Include all handles that share the best score
  return matches
    .filter((m) => m.score === topScore)
    .map((m) => m.handleId);
}
