import { getPglite } from '../db/pglite-client.js';
import { callLLM } from '../llm/query-parser.js';
import type { LLMConfig } from '../llm/query-parser.js';

interface ChatMessage {
  id: number;
  sender: string;
  text: string;
  date: string;
}

interface ChatMessages {
  chatId: number;
  chatName: string;
  messages: ChatMessage[];
}

async function getLastMetadataUpdate(): Promise<Date | null> {
  const db = await getPglite();
  const result = await db.query('SELECT last_updated FROM metadata_meta WHERE id = 1');
  if (result.rows.length === 0) return null;
  return new Date((result.rows[0] as { last_updated: string }).last_updated);
}

async function setLastMetadataUpdate(date: Date): Promise<void> {
  const db = await getPglite();
  await db.query(
    `INSERT INTO metadata_meta (id, last_updated) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_updated = $1`,
    [date.toISOString()]
  );
}

/**
 * Find chats with messages since `since`, and return the 30 most recent
 * messages from each of those chats (for context).
 */
async function getChatsWithNewMessages(since: Date | null, minMessages: number = 1): Promise<ChatMessages[]> {
  const db = await getPglite();

  // Find chat IDs that have new messages since the cutoff
  const afterDate = since ?? new Date('2000-01-01');
  const chatsResult = await db.query(
    `SELECT cmj.chat_id, COUNT(*) as msg_count
     FROM message m
     JOIN chat_message_join cmj ON cmj.message_id = m.id
     WHERE m.date > $1
       AND m.text IS NOT NULL AND m.text != ''
       AND m.associated_message_type = 0
     GROUP BY cmj.chat_id
     HAVING COUNT(*) >= $2`,
    [afterDate.toISOString(), minMessages]
  );

  const chatIds = (chatsResult.rows as { chat_id: number }[]).map((r) => r.chat_id);
  if (chatIds.length === 0) return [];

  const result: ChatMessages[] = [];

  for (const chatId of chatIds) {
    // Get chat display name
    const chatResult = await db.query(
      'SELECT display_name, chat_identifier FROM chat WHERE id = $1',
      [chatId]
    );
    const chat = chatResult.rows[0] as { display_name: string | null; chat_identifier: string } | undefined;
    const chatName = chat?.display_name || chat?.chat_identifier || `Chat ${chatId}`;

    // Get 20 most recent messages with sender info
    const msgResult = await db.query(
      `SELECT m.id, m.text, m.is_from_me, m.date,
              COALESCE(h.display_name, h.identifier, 'Unknown') as sender
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.id
       LEFT JOIN handle h ON h.id = m.handle_id
       WHERE cmj.chat_id = $1
         AND m.text IS NOT NULL AND m.text != ''
         AND m.associated_message_type = 0
       ORDER BY m.date DESC
       LIMIT 20`,
      [chatId]
    );

    const messages = (msgResult.rows as any[])
      .reverse() // chronological order
      .map((r) => ({
        id: r.id,
        sender: r.is_from_me ? 'Me' : r.sender,
        text: r.text,
        date: new Date(r.date).toISOString(),
      }));

    if (messages.length > 0) {
      result.push({ chatId, chatName, messages });
    }
  }

  return result;
}

function buildMetadataPrompt(chats: ChatMessages[]): string {
  const chatBlocks = chats.map((c) => {
    const msgLines = c.messages.map((m) =>
      `[${m.date}] ${m.sender}: ${m.text}`
    ).join('\n');
    return `=== Chat ${c.chatId}: "${c.chatName}" ===\n${msgLines}`;
  }).join('\n\n');

  return chatBlocks;
}

export interface MetadataOptions {
  since?: Date;
  minMessages?: number;
}

export async function updateMetadata(config: LLMConfig, options: MetadataOptions = {}): Promise<number> {
  const since = options.since ?? await getLastMetadataUpdate();
  const minMessages = options.minMessages ?? 1;
  const chats = await getChatsWithNewMessages(since, minMessages);

  if (chats.length === 0) {
    console.log('[metadata] No chats with new messages to summarize.');
    return 0;
  }

  console.log(`[metadata] Summarizing ${chats.length} chat(s)...`);

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const db = await getPglite();

  let totalSummaries = 0;

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    console.log(`  [metadata] ${i + 1}/${chats.length}: "${chat.chatName}"...`);

    try {
      const msgLines = chat.messages.map((m) =>
        `[${m.date}] ${m.sender}: ${m.text}`
      ).join('\n');

      const summary = (await callLLM(
        config,
        `You summarize iMessage conversations. Today is ${today}.

Produce a brief 1-3 sentence summary capturing the key topics, tone, and any notable context (plans being made, questions asked, etc.).

Respond with ONLY the summary text. No JSON, no markdown, no explanation.`,
        `=== Chat "${chat.chatName}" ===\n${msgLines}`,
        512
      )).trim();

      await db.query(
        `INSERT INTO chat_metadata (chat_id, summary, last_updated)
         VALUES ($1, $2, $3)
         ON CONFLICT (chat_id) DO UPDATE SET summary = $2, last_updated = $3`,
        [chat.chatId, summary, now.toISOString()]
      );
      totalSummaries++;
      console.log(`    → ${summary.slice(0, 100)}${summary.length > 100 ? '...' : ''}`);
    } catch (err) {
      console.error(`    ✗ Failed: ${(err as Error).message}`);
    }
  }

  // Run action extraction on the same set of chats before updating the timestamp
  await updateActions(config, chats);

  await setLastMetadataUpdate(now);
  console.log(`\n[metadata] Updated summaries for ${totalSummaries} chat(s).`);
  return totalSummaries;
}

export async function refreshChatMetadata(chatId: number, config: LLMConfig): Promise<string> {
  const db = await getPglite();

  // Get chat info
  const chatResult = await db.query(
    'SELECT display_name, chat_identifier FROM chat WHERE id = $1',
    [chatId]
  );
  const chat = chatResult.rows[0] as { display_name: string | null; chat_identifier: string } | undefined;
  if (!chat) throw new Error(`Chat ${chatId} not found`);
  const chatName = chat.display_name || chat.chat_identifier;

  // Get 30 most recent messages
  const msgResult = await db.query(
    `SELECT m.text, m.is_from_me, m.date,
            COALESCE(h.display_name, h.identifier, 'Unknown') as sender
     FROM message m
     JOIN chat_message_join cmj ON cmj.message_id = m.id
     LEFT JOIN handle h ON h.id = m.handle_id
     WHERE cmj.chat_id = $1
       AND m.text IS NOT NULL AND m.text != ''
       AND m.associated_message_type = 0
     ORDER BY m.date DESC
     LIMIT 30`,
    [chatId]
  );

  const messages = (msgResult.rows as any[])
    .reverse()
    .map((r) => ({
      sender: r.is_from_me ? 'Me' : r.sender,
      text: r.text,
      date: new Date(r.date).toISOString(),
    }));

  if (messages.length === 0) throw new Error(`No messages found for chat ${chatId}`);

  const today = new Date().toISOString().split('T')[0];

  const msgLines = messages.map((m) => `[${m.date}] ${m.sender}: ${m.text}`).join('\n');

  const summary = (await callLLM(
    config,
    `You summarize iMessage conversations. Today is ${today}.

Given a message thread, produce a brief 1-3 sentence summary capturing the key topics, tone, and any notable context (plans being made, questions asked, etc.).

Respond with ONLY the summary text. No JSON, no markdown, no explanation.`,
    `=== Chat "${chatName}" ===\n${msgLines}`,
    512
  )).trim();
  const now = new Date();

  await db.query(
    `INSERT INTO chat_metadata (chat_id, summary, last_updated)
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE SET summary = $2, last_updated = $3`,
    [chatId, summary, now.toISOString()]
  );

  return summary;
}

export async function updateActions(config: LLMConfig, chats?: ChatMessages[]): Promise<number> {
  if (!chats) {
    const since = await getLastMetadataUpdate();
    chats = await getChatsWithNewMessages(since);
  }

  // Get existing incomplete actions for context
  const db = await getPglite();
  const existingResult = await db.query(
    `SELECT id, chat_id, action_descriptor, due_date, created_at
     FROM actions_needed
     WHERE completed = false
     ORDER BY created_at DESC`
  );
  const existingActions = existingResult.rows as {
    id: number;
    chat_id: number;
    action_descriptor: string;
    due_date: string | null;
    created_at: string;
  }[];

  if (chats.length === 0) {
    console.log('[actions] No new messages to check for actions.');
    return 0;
  }

  console.log(`[actions] Checking ${chats.length} chat(s) for action items...`);

  const now = new Date();
  const today = now.toISOString().split('T')[0];

  const systemPrompt = `You extract action items from iMessage conversations. Today is ${today}.

An action item is something concrete that "Me" (the user) has committed to doing, or that requires a meaningful response. Focus on quality over quantity — only create actions for things that would actually fall through the cracks.

CREATE an action when:
- "Me" agreed or offered to do something specific (e.g., "I'll send you that link", "Let me check and get back to you", "I'll book the restaurant")
- Concrete plans were proposed and need confirmation or follow-through (e.g., "Want to grab dinner Friday?", "Let's meet at 7")
- Someone made a specific, direct request that needs a real answer (e.g., "Can you send me those photos?", "What's your address?")
- Someone asked a genuine personal question that "Me" hasn't answered yet (e.g., "How did your interviews go?", "Did you end up going?", "What happened with that job?")
- The conversation ends with the other person's message and "Me" clearly owes a substantive reply
- There's an upcoming event, deadline, or commitment mentioned that requires preparation

DO NOT create an action when:
- The conversation ended with a casual/social message like "thank you", "haha", "sounds good", "nice!", a reaction, or small talk that doesn't need a reply
- Someone asked a purely rhetorical question or made a comment that doesn't need a real answer (e.g., "lol right?", "crazy!")
- The conversation naturally concluded and no one is waiting on anything
- The message is purely informational with no follow-up expected (e.g., sharing a meme, a news article, a photo without context)
- "Me" already replied to the question or request later in the conversation

Only extract actions for "Me" (the user), not for other people. Do NOT duplicate existing actions.

Each message is tagged with its database ID like [MSG-123]. Use this to identify the originating message for each action.

Respond with ONLY valid JSON:
{
  "new_actions": [
    {
      "chat_id": 123,
      "message_id": 456,
      "created_at": "2026-03-12T10:00:00Z",
      "due_date": "2026-03-13T00:00:00Z",
      "action_descriptor": "Respond to Fabian about dinner tomorrow"
    }
  ],
  "completed_action_ids": [5, 12]
}

FIELD GUIDANCE:
- "message_id": The MSG-### ID of the message that triggered this action. Always include this.
- "action_descriptor": Be specific. Include the person's name and what needs to happen.
- "created_at": The timestamp of the message that inspired the action.
- "due_date": Base this on the CONTENT of the message, not arbitrary defaults.
  - If they suggest "dinner tomorrow" and today is ${today}, the due date is TOMORROW — you need to respond before the event.
  - If they say "this weekend", due date is the Friday before.
  - If they say "next week", due date is the Monday of next week.
  - If they mention a specific date ("on the 25th", "March 30"), use that date.
  - If no specific timeframe is mentioned, use null — don't invent urgency.
- "completed_action_ids": IDs of existing actions that the new messages show are resolved (e.g., "Me" responded, plans were confirmed, the event passed).
- If there are no new actions and nothing completed, return {"new_actions": [], "completed_action_ids": []}.

No markdown fencing, no explanation.`;

  let totalNew = 0;
  let totalCompleted = 0;

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];

    // Get existing actions for this chat (both incomplete and completed)
    const freshExisting = await db.query(
      `SELECT id, chat_id, action_descriptor, due_date, created_at, completed
       FROM actions_needed
       WHERE chat_id = $1
       ORDER BY created_at DESC`,
      [chat.chatId]
    );
    const currentActions = freshExisting.rows as (typeof existingActions[number] & { completed: boolean })[];

    const incompleteActions = currentActions.filter((a) => !a.completed);
    const completedActions = currentActions.filter((a) => a.completed);

    let existingBlock = '';
    if (incompleteActions.length > 0) {
      existingBlock += `\n\nEXISTING INCOMPLETE ACTIONS (do not duplicate these):\n${incompleteActions.map((a) =>
        `- [ID ${a.id}]: "${a.action_descriptor}" (due: ${a.due_date ?? 'none'}, created: ${a.created_at})`
      ).join('\n')}`;
    }
    if (completedActions.length > 0) {
      existingBlock += `\n\nALREADY COMPLETED ACTIONS (do NOT recreate these):\n${completedActions.map((a) =>
        `- "${a.action_descriptor}"`
      ).join('\n')}`;
    }

    const msgLines = chat.messages.map((m) =>
      `[MSG-${m.id}] [${m.date}] ${m.sender}: ${m.text}`
    ).join('\n');

    try {
      const text = await callLLM(
        config,
        systemPrompt,
        `=== Chat ${chat.chatId}: "${chat.chatName}" ===\n${msgLines}${existingBlock}`,
        1024
      );
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(jsonStr) as {
        new_actions: {
          chat_id: number;
          message_id: number | null;
          created_at: string;
          due_date: string | null;
          action_descriptor: string;
        }[];
        completed_action_ids: number[];
      };

      for (const action of parsed.new_actions) {
        // Skip if an incomplete action already exists for the same chat + message
        if (action.message_id) {
          const existing = await db.query(
            `SELECT id FROM actions_needed WHERE chat_id = $1 AND message_id = $2 AND completed = false`,
            [chat.chatId, action.message_id]
          );
          if (existing.rows.length > 0) continue;
        }
        await db.query(
          `INSERT INTO actions_needed (chat_id, created_at, due_date, action_descriptor, message_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [chat.chatId, action.created_at, action.due_date, action.action_descriptor, action.message_id ?? null]
        );
        console.log(`  [actions] ${i + 1}/${chats.length} "${chat.chatName}" → ${action.action_descriptor}`);
      }

      if (parsed.completed_action_ids.length > 0) {
        const placeholders = parsed.completed_action_ids.map((_, j) => `$${j + 1}`).join(', ');
        await db.query(
          `UPDATE actions_needed SET completed = true WHERE id IN (${placeholders})`,
          parsed.completed_action_ids
        );
      }

      totalNew += parsed.new_actions.length;
      totalCompleted += parsed.completed_action_ids.length;
    } catch (err) {
      console.error(`  [actions] ${i + 1}/${chats.length} "${chat.chatName}" ✗ ${(err as Error).message}`);
    }
  }

  console.log(`\n[actions] Added ${totalNew} new action(s), completed ${totalCompleted}.`);
  return totalNew;
}
