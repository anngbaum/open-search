import type { SearchResult, SearchOptions } from '../types.js';
import { searchFTS } from './fts.js';
import { searchVector } from './vector.js';

const RRF_K = 60;

/**
 * Reciprocal Rank Fusion (RRF) combines two ranked lists.
 * score(doc) = sum(1 / (k + rank_i)) for each ranker i
 */
export async function searchHybrid(
  query: string,
  options: SearchOptions
): Promise<SearchResult[]> {
  // Fetch more results from each to have enough after fusion
  const expandedOptions = { ...options, limit: (options.limit + options.offset) * 3, offset: 0 };

  // Run both searches in parallel
  const [ftsResults, vectorResults] = await Promise.all([
    searchFTS(query, expandedOptions),
    searchVector(query, expandedOptions).catch(() => {
      // If vector search fails (no embeddings, no Ollama), fall back to FTS only
      console.warn('Vector search unavailable, falling back to text search only.');
      return [] as SearchResult[];
    }),
  ]);

  // Build RRF score map
  const scoreMap = new Map<number, { result: SearchResult; rrfScore: number }>();

  ftsResults.forEach((result, rank) => {
    const rrfScore = 1 / (RRF_K + rank + 1);
    scoreMap.set(result.id, { result, rrfScore });
  });

  vectorResults.forEach((result, rank) => {
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scoreMap.get(result.id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      scoreMap.set(result.id, { result, rrfScore });
    }
  });

  // Sort by combined RRF score
  const combined = Array.from(scoreMap.values())
    .sort((a, b) => {
      const scoreDiff = b.rrfScore - a.rrfScore;
      if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
      const dateA = a.result.date ? new Date(a.result.date).getTime() : 0;
      const dateB = b.result.date ? new Date(b.result.date).getTime() : 0;
      return dateB - dateA;
    })
    .slice(options.offset, options.offset + options.limit)
    .map((entry, idx) => ({
      ...entry.result,
      score: entry.rrfScore,
      rank: idx + 1,
    }));

  return combined;
}
