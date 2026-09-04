import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { minifiedResult, schemaConfirm, toolAnnotations } from '@chrischall/mcp-utils';
import type { RemindClient } from '../client.js';
import { CHAT_MESSAGES, CHAT_STREAMS, PUT_MESSAGE } from '../queries.js';

export function registerChatTools(server: McpServer, client: RemindClient): void {
  server.registerTool(
    'remind_list_chats',
    {
      description:
        'List conversation streams with unread counts, member counts, last-updated time and the ' +
        'per-stream permissions (notably `canSend`). Filter to specific uuids, a class, or a search string.',
      annotations: toolAnnotations({ title: 'Remind list chats', readOnly: true, idempotent: true }),
      inputSchema: {
        uuids: z.array(z.string()).optional().describe('Restrict to these chat stream uuids.'),
        class_id: z.number().int().optional().describe('Numeric class id to scope chats to.'),
        query: z.string().optional().describe('Search chats by participant/title.'),
      },
    },
    async ({ uuids, class_id, query }) =>
      minifiedResult(
        await client.graphql(CHAT_STREAMS, {
          chatUuids: uuids ?? null,
          groupId: class_id ?? null,
          chatQuery: query ?? null,
        }),
      ),
  );

  server.registerTool(
    'remind_get_messages',
    {
      description:
        'Read messages in one or more chat streams, newest-last. Items are typed: MessageItem (a real ' +
        'message with sender, body and attachments), SystemMessageItem (joins, stream creation) or ' +
        'GapItem (a paging gap of `size` unloaded messages).',
      annotations: toolAnnotations({ title: 'Remind get messages', readOnly: true, idempotent: true }),
      inputSchema: {
        uuids: z.array(z.string()).min(1).describe('Chat stream uuids, from remind_list_chats.'),
        limit: z.number().int().min(1).max(200).default(25).describe('Max non-gap messages per stream.'),
      },
    },
    async ({ uuids, limit }) => minifiedResult(await client.graphql(CHAT_MESSAGES, { chatUuids: uuids, limit })),
  );

  server.registerTool(
    'remind_send_message',
    {
      description:
        'Send a message to a chat stream or class. Delivers to real people and CANNOT be unsent, so it is ' +
        'confirm-gated: without confirm:true it makes NO network call and returns a dry-run preview of the ' +
        'exact payload. Check `permissions.canSend` on the target first (remind_list_chats).',
      annotations: toolAnnotations({ title: 'Remind send message', readOnly: false }),
      inputSchema: {
        recipient_uuid: z.string().describe('Chat stream uuid, or class uuid.'),
        recipient_type: z
          .enum(['chat', 'group'])
          .default('chat')
          .describe('`chat` for a conversation stream, `group` for a whole class.'),
        body: z.string().min(1).describe('Message text.'),
        urgent: z.boolean().default(false).describe('Send as an urgent message.'),
        confirm: schemaConfirm,
      },
    },
    async ({ recipient_uuid, recipient_type, body, urgent, confirm }) => {
      const input = {
        recipients: [{ type: recipient_type, uuid: recipient_uuid }],
        message: { body, urgent },
      };
      if (!confirm) {
        return minifiedResult({
          dryRun: true,
          wouldSend: { mutation: 'putMessage', input },
          warning: 'This delivers to real recipients and cannot be unsent. Re-run with confirm: true.',
        });
      }
      return minifiedResult(await client.graphql(PUT_MESSAGE, { input }));
    },
  );
}
