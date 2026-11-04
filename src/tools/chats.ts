import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  McpToolError,
  confirmTokenParam,
  confirmWrite,
  CONFIRM_FLOW_SENTENCE,
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  minifiedResult,
  toolAnnotations,
  untrustedEnvelope,
  untrustedResult,
} from '@chrischall/mcp-utils';
import type { RemindClient } from '../client.js';
import { CHAT_MESSAGES, CHAT_STREAMS, CLASSES, PUT_MESSAGE } from '../queries.js';
import { signedInAccount } from './account.js';
import { schoolMeta } from './hints.js';

const BRIEF_MAX = 120;

interface ChatStreamRow {
  title?: string | null;
  properTitle?: string | null;
  unreadMessagesCount?: number | null;
  updatedAt?: string | null;
}

function flat(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.replace(/\s+/g, ' ').trim() : undefined;
}

/** The shortest a title is cut to before the tail gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s);

/**
 * One chat with unread messages as one line, `title — <ISO date | no date> —
 * N unread`, cut to at most 120 characters as a WHOLE, title first: the title
 * shortens until the line fits, and only if the tail alone would still
 * overflow once the title is at its floor is the tail cut as well. The date is
 * the stream's `updatedAt`, as Remind reports it. A title starting with `-- `
 * (a note's prefix) or `\` is escaped with one leading `\`, which the host
 * strips after its note check, so a chat title can never read as a note.
 */
export function briefChatLine(chat: ChatStreamRow): string {
  const raw = flat(chat.properTitle) ?? flat(chat.title) ?? '(untitled)';
  const title = raw.startsWith('-- ') || raw.startsWith('\\') ? `\\${raw}` : raw;
  const tail = ` — ${flat(chat.updatedAt) ?? 'no date'} — ${chat.unreadMessagesCount ?? 0} unread`;
  if (title.length + tail.length <= BRIEF_MAX) return `${title}${tail}`;
  const shown = cut(title, Math.max(BRIEF_MAX - tail.length, Math.min(title.length, TITLE_FLOOR)));
  return `${shown}${cut(tail, BRIEF_MAX - shown.length)}`;
}

/** Who wrote the brief lines' text, for the untrusted envelope's note. */
const BRIEF_NOTE =
  `Chat titles and participant names are written by teachers, schools and other Remind members, not the user. ${UNTRUSTED_CONTENT_RULE}`;

/**
 * The brief answer: the lines (or the single note `-- none`) inside the
 * fleet's untrusted-data envelope as `data: string[]`, minified, note first —
 * chat titles are third-party text, exactly like the full rung's payload.
 */
export function briefChatsResult(chats: ChatStreamRow[]): ReturnType<typeof minifiedResult> {
  const unread = chats.filter((c) => (c.unreadMessagesCount ?? 0) > 0);
  const lines = unread.length === 0 ? ['-- none'] : unread.map(briefChatLine);
  return minifiedResult(untrustedEnvelope(lines, { note: BRIEF_NOTE }));
}

interface PutMessageResult {
  putMessage: {
    error: { __typename?: string } | null;
    messages: unknown[] | null;
  } | null;
}

interface Recipient {
  title?: string | null;
  properTitle?: string | null;
  displayName?: string | null;
  name?: string | null;
  membershipsCount?: number | null;
}

/**
 * Who a send reaches, in words: `Coach Smith (chat, 2 members)` or
 * `Math 101 (whole class, 31 members)`. A bare uuid cannot tell a parent
 * approving the send whether it goes to one teacher or to thirty families,
 * which is the one fact the confirmation exists to put in front of them.
 * Bound as the token's revision, so a target renamed or regrown between the
 * preview and the confirmed call is refused as DRAFT_CHANGED.
 */
async function describeRecipient(client: RemindClient, uuid: string, type: 'chat' | 'group'): Promise<string> {
  let found: Recipient | undefined;
  if (type === 'group') {
    const data = await client.graphql<{ classes?: Recipient[] | null }>(CLASSES, { uuids: [uuid] });
    found = data.classes?.[0];
  } else {
    const data = await client.graphql<{ chatStreams?: Recipient[] | null }>(CHAT_STREAMS, {
      chatUuids: [uuid],
      groupId: null,
      chatQuery: null,
    });
    found = data.chatStreams?.[0];
  }
  if (!found) {
    throw new McpToolError(`No ${type === 'group' ? 'class' : 'chat'} ${uuid} is visible to this account; nothing was sent.`, {
      hint:
        type === 'group'
          ? 'Find the class uuid with remind_get_classes or remind_list_entities.'
          : 'Find the chat uuid with remind_list_chats.',
    });
  }
  const label =
    (type === 'group' ? found.displayName || found.name : found.properTitle || found.title) || '(untitled)';
  const members = found.membershipsCount == null ? '' : `, ${found.membershipsCount} members`;
  return `${label} (${type === 'group' ? 'whole class' : 'chat'}${members})`;
}

export function registerChatTools(server: McpServer, client: RemindClient): void {
  server.registerTool(
    'remind_list_chats',
    {
      description:
        'List conversation streams with unread counts, member counts, last-updated time and the ' +
        'per-stream permissions (notably `canSend`). Filter to specific uuids, a class, or a search string. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Remind list chats', readOnly: true, idempotent: true, openWorld: true }),
      _meta: schoolMeta('whats-new', {
        canonical: true,
        aliases: ['remind', 'teacher', 'messages', 'unread', 'school', 'coach', 'texts'],
      }),
      inputSchema: z.object({
        uuids: z.array(z.string()).optional().describe('Restrict to these chat stream uuids.'),
        class_id: z.number().int().optional().describe('Numeric class id to scope chats to.'),
        query: z.string().optional().describe('Search chats by participant/title.'),
        view: z
          .enum(['full', 'brief'])
          .optional()
          .describe(
            '"full" (default) returns the chat streams; "brief" returns one line per chat WITH unread messages ' +
              '(the note "-- none" when none): title — <last updated, ISO, or "no date"> — <N> unread, ' +
              'inside the untrusted-data envelope as data: string[].',
          ),
      }),
    },
    async ({ uuids, class_id, query, view }) => {
      const data = await client.graphql<{ chatStreams?: ChatStreamRow[] | null }>(CHAT_STREAMS, {
        chatUuids: uuids ?? null,
        groupId: class_id ?? null,
        chatQuery: query ?? null,
      });
      if (view === 'brief') return briefChatsResult(data.chatStreams ?? []);
      return untrustedResult(data);
    },
  );

  server.registerTool(
    'remind_get_messages',
    {
      description:
        'Read messages in one or more chat streams, newest-last. Items are typed: MessageItem (a real ' +
        'message with sender, body and attachments), SystemMessageItem (joins, stream creation) or ' +
        'GapItem (a paging gap of `size` unloaded messages). ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Remind get messages', readOnly: true, idempotent: true, openWorld: true }),
      _meta: schoolMeta('lookup', { aliases: ['messages', 'what the teacher said', 'chat'] }),
      inputSchema: z.object({
        uuids: z.array(z.string()).min(1).describe('Chat stream uuids, from remind_list_chats.'),
        limit: z.number().int().min(1).max(200).default(25).describe('Max non-gap messages per stream.'),
      }),
    },
    async ({ uuids, limit }) => untrustedResult(await client.graphql(CHAT_MESSAGES, { chatUuids: uuids, limit })),
  );

  server.registerTool(
    'remind_send_message',
    {
      description:
        'Send a message to a chat stream or class. Delivers to real people and CANNOT be unsent. ' +
        'Nothing is sent until confirmed; the preview names the recipient and shows the exact payload. ' +
        CONFIRM_FLOW_SENTENCE + ' ' +
        'Check `permissions.canSend` on the target first (remind_list_chats).',
      annotations: toolAnnotations({ title: 'Remind send message', readOnly: false, destructive: true, openWorld: true }),
      _meta: schoolMeta('send', { aliases: ['message the teacher', 'text the class', 'reply', 'remind'] }),
      inputSchema: z.object({
        recipient_uuid: z.string().describe('Chat stream uuid, or class uuid.'),
        recipient_type: z
          .enum(['chat', 'group'])
          .default('chat')
          .describe('`chat` for a conversation stream, `group` for a whole class.'),
        body: z.string().min(1).describe('Message text.'),
        urgent: z.boolean().default(false).describe('Send as an urgent message.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ recipient_uuid, recipient_type, body, urgent, confirmToken }, ctx) => {
      const input = {
        recipients: [{ type: recipient_type, uuid: recipient_uuid }],
        message: { body, urgent },
      };
      const recipient = await describeRecipient(client, recipient_uuid, recipient_type);
      const gate = await confirmWrite(ctx, {
        tool: 'remind_send_message',
        action: 'chat.send_message',
        message: 'Review and confirm this message. It delivers to real recipients and cannot be unsent:',
        account: await signedInAccount(client),
        target: recipient_uuid,
        revision: recipient,
        payload: { mutation: 'putMessage', input },
        preview: { recipient, warning: 'This delivers to real recipients and cannot be unsent.' },
        confirmToken,
      });
      if (gate) return gate;
      // A refused send (canSend=false, unknown recipient, blocked…) comes back as
      // HTTP 200 data with `putMessage.error` populated, not as GraphQL
      // `errors`, so the client does not throw on it. Surface it as a tool
      // error rather than a payload that reads like a completed send.
      const data = await client.graphql<PutMessageResult>(PUT_MESSAGE, { input });
      const error = data.putMessage?.error;
      if (error) {
        throw new McpToolError(`Remind refused the message: ${error.__typename ?? 'unknown error'}.`, {
          hint: 'Nothing was sent. Check permissions.canSend on the target via remind_list_chats.',
        });
      }
      const messages = data.putMessage?.messages ?? [];
      if (messages.length === 0) {
        throw new McpToolError('Remind accepted the request but reported no message sent.', {
          hint: 'Check the chat with remind_get_messages before retrying, so the message is not sent twice.',
        });
      }
      return minifiedResult({ sent: true, messages });
    },
  );
}
