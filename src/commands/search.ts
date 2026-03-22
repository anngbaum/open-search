import type { SearchOptions } from '../types.js';
import { searchFTS } from '../search/fts.js';
import { searchVector } from '../search/vector.js';
import { searchHybrid } from '../search/hybrid.js';
import { formatSearchResults, getContextMessages, formatContextMessages } from '../display/formatter.js';
import { getPglite } from '../db/pglite-client.js';

export async function search(query: string, options: SearchOptions): Promise<void> {
  // Ensure PGLite is initialized
  await getPglite();

  let results;

  switch (options.mode) {
    case 'text':
      results = await searchFTS(query, options);
      break;
    case 'semantic':
      results = await searchVector(query, options);
      break;
    case 'hybrid':
      results = await searchHybrid(query, options);
      break;
    default:
      throw new Error(`Unknown search mode: ${options.mode}`);
  }

  console.log(formatSearchResults(results, options.mode));

  // Show context if requested
  if (options.context > 0 && results.length > 0) {
    for (const result of results) {
      const ctx = await getContextMessages(result.id, options.context, options.context);
      if (ctx.length > 0) {
        console.log(formatContextMessages(ctx));
        console.log('');
      }
    }
  }
}
