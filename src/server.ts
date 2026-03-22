import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { getPglite, closePglite, initSchema } from './db/pglite-client.js';
import { DATA_DIR } from './config.js';
import { searchFTS } from './search/fts.js';
import { searchVector } from './search/vector.js';
import { searchHybrid } from './search/hybrid.js';
import { getContextMessages } from './display/formatter.js';
import { parseNaturalQuery, disposeQueryParser, AVAILABLE_MODELS } from './llm/query-parser.js';
import { searchContacts, resolveContactHandleIds } from './contacts/search.js';
import { unifiedSync } from './commands/unified-sync.js';
import { updateMetadata, refreshChatMetadata } from './commands/update-metadata.js';
import { getThread, NotFoundError } from './thread/thread.js';
import type { SearchOptions } from './types.js';

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let syncInProgress = false;
let syncTimer: ReturnType<typeof setInterval> | null = null;

function getLLMConfig() {
  return {
    model: settings.selectedModel ?? 'claude-haiku-4-5-20251001',
    anthropicApiKey: settings.anthropicApiKey,
    openaiApiKey: settings.openaiApiKey,
  };
}

async function runSync(hardReset = false): Promise<void> {
  if (syncInProgress) {
    console.log('[scheduler] Sync already in progress, skipping.');
    return;
  }
  syncInProgress = true;
  try {
    const result = await unifiedSync({
      hardReset,
      llmConfig: getLLMConfig(),
    });
    console.log(`[scheduler] Sync done: ${result.messagesAdded} messages, ${result.handlesAdded} handles.`);
  } catch (err) {
    console.error('[scheduler] Sync error:', err);
  } finally {
    syncInProgress = false;
  }
}

const PORT = 11488;
const HOST = 'localhost';

// Settings persistence
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

interface AppSettings {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  selectedModel?: string;
}

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch {
    // Ignore corrupt settings
  }
  return {};
}

function saveSettings(settings: AppSettings): void {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

let settings = loadSettings();

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(
  res: http.ServerResponse,
  data: unknown,
  status: number = 200
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsHeaders(),
  });
  res.end(body);
}

function errorResponse(
  res: http.ServerResponse,
  message: string,
  status: number = 400
): void {
  jsonResponse(res, { error: message }, status);
}

async function handleSearch(
  params: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  const query = params.get('q');
  if (!query) {
    errorResponse(res, 'Missing required parameter: q');
    return;
  }

  const mode = (params.get('mode') || 'text') as SearchOptions['mode'];
  if (!['text', 'semantic', 'hybrid'].includes(mode)) {
    errorResponse(res, 'Invalid mode. Must be: text, semantic, or hybrid');
    return;
  }

  const limit = Math.min(parseInt(params.get('limit') || '20', 10) || 20, 100);
  const offset = Math.max(parseInt(params.get('offset') || '0', 10) || 0, 0);

  const options: SearchOptions = {
    mode,
    limit: limit + 1, // fetch one extra to detect if there are more
    offset,
    context: 0,
  };

  if (params.get('from')) options.from = params.get('from')!;
  if (params.getAll('withContact').length > 0) options.withContacts = params.getAll('withContact');
  if (params.get('groupChatName')) options.groupChatName = params.get('groupChatName')!;
  if (params.get('after')) options.after = params.get('after')!;
  if (params.get('before')) options.before = params.get('before')!;
  if (params.get('fromMe') === 'true') options.fromMe = true;
  if (params.get('toMe') === 'true') options.toMe = true;

  let results;
  switch (mode) {
    case 'text':
      results = await searchFTS(query, options);
      break;
    case 'semantic':
      results = await searchVector(query, options);
      break;
    case 'hybrid':
      results = await searchHybrid(query, options);
      break;
  }

  const hasMore = results.length > limit;
  const trimmed = hasMore ? results.slice(0, limit) : results;
  jsonResponse(res, { results: trimmed, count: trimmed.length, hasMore, mode });
}

async function handleContacts(
  res: http.ServerResponse
): Promise<void> {
  const db = await getPglite();
  const result = await db.query(`
    SELECT
      COALESCE(display_name, identifier) as name,
      array_agg(DISTINCT identifier ORDER BY identifier) as identifiers
    FROM handle
    WHERE identifier IS NOT NULL
    GROUP BY COALESCE(display_name, identifier)
    ORDER BY name
  `);
  const contacts = (result.rows as any[]).map((r) => ({
    name: r.name,
    identifiers: r.identifiers,
  }));
  jsonResponse(res, { contacts });
}

async function handleGroups(
  res: http.ServerResponse
): Promise<void> {
  const db = await getPglite();
  const result = await db.query(`
    SELECT DISTINCT display_name as name, chat_identifier
    FROM chat
    WHERE display_name IS NOT NULL AND display_name != ''
    ORDER BY name
  `);
  jsonResponse(res, { groups: result.rows.map((r: any) => ({ name: r.name, chatIdentifier: r.chat_identifier })) });
}

async function handleAsk(
  params: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  const query = params.get('q');
  if (!query) {
    errorResponse(res, 'Missing required parameter: q');
    return;
  }

  const parsed = await parseNaturalQuery(query, {
    model: settings.selectedModel ?? 'claude-haiku-4-5-20251001',
    anthropicApiKey: settings.anthropicApiKey,
    openaiApiKey: settings.openaiApiKey,
  });

  // Manual filters from the client take precedence over LLM-parsed ones
  const manualFrom = params.get('from') || undefined;
  const manualGroupChatName = params.get('groupChatName') || undefined;
  const manualAfter = params.get('after') || undefined;
  const manualBefore = params.get('before') || undefined;
  const manualFromMe = params.get('fromMe') === 'true';
  const manualToMe = params.get('toMe') === 'true';

  const effectiveFrom = manualFrom ?? parsed.from;
  const effectiveGroupChatName = manualGroupChatName ?? parsed.groupChatName;
  const effectiveAfter = manualAfter ?? parsed.after;
  const effectiveBefore = manualBefore ?? parsed.before;
  const effectiveFromMe = manualFromMe || (parsed.fromMe ?? false);
  const effectiveToMe = manualToMe || (parsed.toMe ?? false);

  // Resolve contact name to actual handle IDs
  let handleIds: number[] | undefined;
  let resolvedContact: { name: string; handleIds: number[] } | undefined;

  if (effectiveFrom) {
    const matches = await searchContacts(effectiveFrom, 5);
    if (matches.length > 0) {
      const topScore = matches[0].score;
      const topMatches = matches.filter((m) => m.score === topScore);
      handleIds = topMatches.map((m) => m.handleId);
      resolvedContact = {
        name: topMatches[0].displayName ?? topMatches[0].identifier,
        handleIds,
      };
    }
  }

  const mode = parsed.mode ?? 'hybrid';
  const limit = Math.min(parseInt(params.get('limit') || '20', 10) || 20, 100);

  const options: SearchOptions = {
    mode,
    limit,
    offset: 0,
    context: 0,
    from: handleIds ? undefined : effectiveFrom,
    handleIds,
    groupChatName: effectiveGroupChatName,
    after: effectiveAfter,
    before: effectiveBefore,
    fromMe: effectiveFromMe,
    toMe: effectiveToMe,
  };

  let results;
  switch (mode) {
    case 'text':
      results = await searchFTS(parsed.query, options);
      break;
    case 'semantic':
      results = await searchVector(parsed.query, options);
      break;
    case 'hybrid':
      results = await searchHybrid(parsed.query, options);
      break;
  }

  jsonResponse(res, {
    interpreted: parsed,
    resolvedContact,
    results,
    count: results.length,
    mode,
  });
}

async function handleContactSearch(
  params: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  const query = params.get('q');
  if (!query) {
    errorResponse(res, 'Missing required parameter: q');
    return;
  }

  const limit = Math.min(parseInt(params.get('limit') || '5', 10) || 5, 20);
  const matches = await searchContacts(query, limit);
  jsonResponse(res, { matches, count: matches.length });
}

async function handleContext(
  params: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  const messageIdStr = params.get('messageId');
  if (!messageIdStr) {
    errorResponse(res, 'Missing required parameter: messageId');
    return;
  }

  const messageId = parseInt(messageIdStr, 10);
  if (isNaN(messageId)) {
    errorResponse(res, 'messageId must be a number');
    return;
  }

  const before = parseInt(params.get('before') || '3', 10) || 3;
  const after = parseInt(params.get('after') || '10', 10) || 10;
  const messages = await getContextMessages(messageId, before, after);

  jsonResponse(res, { messages, count: messages.length });
}

async function handleThread(
  params: URLSearchParams,
  res: http.ServerResponse
): Promise<void> {
  const messageIdStr = params.get('messageId');
  if (!messageIdStr) {
    errorResponse(res, 'Missing required parameter: messageId');
    return;
  }

  const messageId = parseInt(messageIdStr, 10);
  if (isNaN(messageId)) {
    errorResponse(res, 'messageId must be a number');
    return;
  }

  const cursor = params.get('cursor') || undefined;
  const direction = params.get('direction') as 'older' | 'newer' | undefined;

  if (cursor && !direction) {
    errorResponse(res, 'direction is required when cursor is provided');
    return;
  }
  if (direction && !['older', 'newer'].includes(direction)) {
    errorResponse(res, 'direction must be "older" or "newer"');
    return;
  }

  const before = params.get('before') ? parseInt(params.get('before')!, 10) : undefined;
  const after = params.get('after') ? parseInt(params.get('after')!, 10) : undefined;
  const limit = params.get('limit') ? parseInt(params.get('limit')!, 10) : undefined;

  try {
    const result = await getThread({ messageId, before, after, cursor, direction, limit });
    jsonResponse(res, result);
  } catch (err) {
    if (err instanceof NotFoundError) {
      errorResponse(res, err.message, 404);
      return;
    }
    throw err;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function maskKey(key: string): string {
  return key.length > 12
    ? key.slice(0, 7) + '...' + key.slice(-4)
    : '***';
}

async function handleModels(res: http.ServerResponse): Promise<void> {
  const models = AVAILABLE_MODELS.map((m) => ({
    ...m,
    available: m.provider === 'anthropic'
      ? !!settings.anthropicApiKey
      : !!settings.openaiApiKey,
  }));
  jsonResponse(res, { models });
}

async function handleGetSettings(res: http.ServerResponse): Promise<void> {
  // Return settings with API keys masked
  const masked: AppSettings = { ...settings };
  if (masked.anthropicApiKey) {
    masked.anthropicApiKey = maskKey(masked.anthropicApiKey);
  }
  if (masked.openaiApiKey) {
    masked.openaiApiKey = maskKey(masked.openaiApiKey);
  }
  jsonResponse(res, masked);
}

async function handlePutSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readBody(req);
  let update: Partial<AppSettings>;
  try {
    update = JSON.parse(body);
  } catch {
    errorResponse(res, 'Invalid JSON body');
    return;
  }

  if (update.anthropicApiKey !== undefined) {
    settings.anthropicApiKey = update.anthropicApiKey || undefined;
  }
  if (update.openaiApiKey !== undefined) {
    settings.openaiApiKey = update.openaiApiKey || undefined;
  }
  if (update.selectedModel !== undefined) {
    settings.selectedModel = update.selectedModel || undefined;
  }

  saveSettings(settings);
  jsonResponse(res, { ok: true });
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT') {
    errorResponse(res, 'Method not allowed', 405);
    return;
  }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const params = url.searchParams;

  try {
    // PUT routes
    if (req.method === 'PUT') {
      switch (url.pathname) {
        case '/api/settings':
          await handlePutSettings(req, res);
          break;
        default:
          errorResponse(res, 'Not found', 404);
      }
      return;
    }

    // POST routes
    if (req.method === 'POST') {
      switch (url.pathname) {
        case '/api/chat-metadata/refresh': {
          const chatIdStr = params.get('chatId');
          if (!chatIdStr) {
            errorResponse(res, 'Missing required parameter: chatId');
            break;
          }
          const chatId = parseInt(chatIdStr, 10);
          if (isNaN(chatId)) {
            errorResponse(res, 'chatId must be a number');
            break;
          }
          try {
            const llmConfig = {
              model: settings.selectedModel ?? 'claude-haiku-4-5-20251001',
              anthropicApiKey: settings.anthropicApiKey,
              openaiApiKey: settings.openaiApiKey,
            };
            const summary = await refreshChatMetadata(chatId, llmConfig);
            jsonResponse(res, { chat_id: chatId, summary });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/update-metadata': {
          try {
            const llmConfig = {
              model: settings.selectedModel ?? 'claude-haiku-4-5-20251001',
              anthropicApiKey: settings.anthropicApiKey,
              openaiApiKey: settings.openaiApiKey,
            };
            const sinceParam = params.get('since');
            const since = sinceParam ? new Date(sinceParam) : undefined;
            const minMessages = parseInt(params.get('minMessages') || '1', 10);
            const count = await updateMetadata(llmConfig, { since, minMessages });
            jsonResponse(res, { updated: count });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/actions/complete': {
          const actionIdStr = params.get('id');
          if (!actionIdStr) {
            errorResponse(res, 'Missing required parameter: id');
            break;
          }
          const actionId = parseInt(actionIdStr, 10);
          if (isNaN(actionId)) {
            errorResponse(res, 'id must be a number');
            break;
          }
          try {
            const db = await getPglite();
            await db.query('UPDATE actions_needed SET completed = true WHERE id = $1', [actionId]);
            jsonResponse(res, { ok: true });
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          }
          break;
        }
        case '/api/sync': {
          if (syncInProgress) {
            jsonResponse(res, { error: 'Sync already in progress' }, 409);
            break;
          }
          syncInProgress = true;
          try {
            const result = await unifiedSync({ llmConfig: getLLMConfig() });
            jsonResponse(res, result);
          } catch (err) {
            errorResponse(res, (err as Error).message, 500);
          } finally {
            syncInProgress = false;
          }
          break;
        }
        default:
          errorResponse(res, 'Not found', 404);
      }
      return;
    }

    // GET routes
    switch (url.pathname) {
      case '/health':
        jsonResponse(res, { status: 'ok' });
        break;
      case '/api/search':
        await handleSearch(params, res);
        break;
      case '/api/ask':
        await handleAsk(params, res);
        break;
      case '/api/contacts':
        await handleContacts(res);
        break;
      case '/api/groups':
        await handleGroups(res);
        break;
      case '/api/contacts/search':
        await handleContactSearch(params, res);
        break;
      case '/api/context':
        await handleContext(params, res);
        break;
      case '/api/thread':
        await handleThread(params, res);
        break;
      case '/api/settings':
        await handleGetSettings(res);
        break;
      case '/api/models':
        await handleModels(res);
        break;
      case '/api/chat-metadata': {
        const db = await getPglite();
        const metaResult = await db.query(
          `SELECT cm.chat_id, cm.summary, cm.last_updated,
                  CASE
                    WHEN c.display_name IS NOT NULL AND c.display_name != '' THEN c.display_name
                    WHEN (SELECT COUNT(*) FROM chat_handle_join _chj WHERE _chj.chat_id = c.id) > 1 THEN
                      'chat with ' || (
                        SELECT string_agg(_sub.name, ', ')
                        FROM (
                          SELECT COALESCE(_h.display_name, _h.identifier) as name
                          FROM chat_handle_join _chj2
                          JOIN handle _h ON _chj2.handle_id = _h.id
                          WHERE _chj2.chat_id = c.id
                          ORDER BY _h.id
                          LIMIT 6
                        ) _sub
                      )
                    ELSE (
                      SELECT COALESCE(_h2.display_name, _h2.identifier)
                      FROM chat_handle_join _chj3
                      JOIN handle _h2 ON _chj3.handle_id = _h2.id
                      WHERE _chj3.chat_id = c.id
                      LIMIT 1
                    )
                  END as chat_name,
                  (SELECT MAX(m.date) FROM message m
                   JOIN chat_message_join cmj ON cmj.message_id = m.id
                   WHERE cmj.chat_id = cm.chat_id) as latest_message_date
           FROM chat_metadata cm
           LEFT JOIN chat c ON c.id = cm.chat_id
           ORDER BY latest_message_date DESC NULLS LAST`
        );
        jsonResponse(res, { metadata: metaResult.rows });
        break;
      }
      case '/api/actions': {
        const db = await getPglite();
        const showCompleted = params.get('completed') === 'true';
        const actionsResult = await db.query(
          `SELECT an.*,
                  CASE
                    WHEN c.display_name IS NOT NULL AND c.display_name != '' THEN c.display_name
                    WHEN (SELECT COUNT(*) FROM chat_handle_join _chj WHERE _chj.chat_id = c.id) > 1 THEN
                      'chat with ' || (
                        SELECT string_agg(_sub.name, ', ')
                        FROM (
                          SELECT COALESCE(_h.display_name, _h.identifier) as name
                          FROM chat_handle_join _chj2
                          JOIN handle _h ON _chj2.handle_id = _h.id
                          WHERE _chj2.chat_id = c.id
                          ORDER BY _h.id
                          LIMIT 6
                        ) _sub
                      )
                    ELSE (
                      SELECT COALESCE(_h2.display_name, _h2.identifier)
                      FROM chat_handle_join _chj3
                      JOIN handle _h2 ON _chj3.handle_id = _h2.id
                      WHERE _chj3.chat_id = c.id
                      LIMIT 1
                    )
                  END as chat_name
           FROM actions_needed an
           LEFT JOIN chat c ON c.id = an.chat_id
           ${showCompleted ? '' : 'WHERE an.completed = false'}
           ORDER BY an.due_date ASC NULLS LAST, an.created_at DESC`
        );
        jsonResponse(res, { actions: actionsResult.rows });
        break;
      }
      default:
        errorResponse(res, 'Not found', 404);
    }
  } catch (err) {
    console.error('Request error:', err);
    errorResponse(
      res,
      err instanceof Error ? err.message : 'Internal server error',
      500
    );
  }
});

async function start(): Promise<void> {
  const hardReset = process.argv.includes('--hard-reset');

  console.log('Initializing PGLite...');
  await getPglite();
  await initSchema();
  console.log('PGLite ready.');

  server.listen(PORT, HOST, () => {
    console.log(`OpenSearch API server running at http://${HOST}:${PORT}`);
    console.log('Endpoints:');
    console.log('  GET /api/search?q=...&mode=text|semantic|hybrid&limit=20');
    console.log('  GET /api/ask?q=...&limit=20');
    console.log('  GET /api/contacts');
    console.log('  GET /api/groups');
    console.log('  GET /api/contacts/search?q=...&limit=5');
    console.log('  GET /api/context?messageId=...&count=5');
    console.log('  GET /api/thread?messageId=...&before=25&after=25');
    console.log('  GET /api/settings');
    console.log('  PUT /api/settings');
    console.log('  POST /api/sync');
  });

  // Run sync on startup (hard reset if --hard-reset flag passed), then schedule hourly
  if (hardReset) {
    console.log('[startup] Hard reset requested via --hard-reset flag.');
  }
  runSync(hardReset).catch((err) => console.error('[scheduler] Startup sync failed:', err));
  syncTimer = setInterval(() => {
    runSync().catch((err) => console.error('[scheduler] Scheduled sync failed:', err));
  }, SYNC_INTERVAL_MS);
}

async function shutdown() {
  console.log('\nShutting down...');
  if (syncTimer) clearInterval(syncTimer);
  server.close();
  await disposeQueryParser();
  await closePglite();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
