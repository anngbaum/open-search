import { parseNaturalQuery } from '../llm/query-parser.js';
import { search } from './search.js';
import { searchContacts, resolveContactHandleIds } from '../contacts/search.js';
import type { SearchOptions } from '../types.js';

export async function ask(input: string, opts: { limit: number; context: number }): Promise<void> {
  console.log(`Parsing: "${input}" ...\n`);

  const parsed = await parseNaturalQuery(input);

  // Resolve contact name to actual handle IDs
  let handleIds: number[] | undefined;
  let resolvedName: string | undefined;

  if (parsed.from) {
    const matches = await searchContacts(parsed.from, 5);
    if (matches.length > 0) {
      const topScore = matches[0].score;
      const topMatches = matches.filter((m) => m.score === topScore);
      handleIds = topMatches.map((m) => m.handleId);
      resolvedName = topMatches[0].displayName ?? topMatches[0].identifier;
    }
  }

  // Display interpreted query
  const parts: string[] = [];
  parts.push(`Search "${parsed.query}"`);
  if (parsed.from) {
    if (resolvedName) {
      parts.push(`From: ${resolvedName} (matched "${parsed.from}")`);
    } else {
      parts.push(`From: ${parsed.from} (no match found, using fuzzy filter)`);
    }
  }
  if (parsed.groupChatName) parts.push(`Chat: ${parsed.groupChatName}`);
  if (parsed.after) parts.push(`After: ${parsed.after}`);
  if (parsed.before) parts.push(`Before: ${parsed.before}`);
  if (parsed.fromMe) parts.push('From: me');
  if (parsed.toMe) parts.push('To: me');
  if (parsed.mode) parts.push(`Mode: ${parsed.mode}`);
  console.log(`Interpreted as: ${parts.join(', ')}\n`);

  const searchOptions: SearchOptions = {
    mode: parsed.mode ?? 'hybrid',
    from: handleIds ? undefined : parsed.from,
    handleIds,
    groupChatName: parsed.groupChatName,
    after: parsed.after,
    before: parsed.before,
    fromMe: parsed.fromMe ?? false,
    toMe: parsed.toMe ?? false,
    limit: opts.limit,
    offset: 0,
    context: opts.context,
  };

  await search(parsed.query, searchOptions);
}
