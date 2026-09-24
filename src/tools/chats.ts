import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  McpToolError,
  confirmTokenParam,
  confirmationFromEnv,
  minifiedResult,
  requireConfirmationWithFallback,
  toolAnnotations,
} from '@chrischall/mcp-utils';
import type { RemindClient } from '../client.js';
import { CHAT_MESSAGES, CHAT_STREAMS, PUT_MESSAGE } from '../queries.js';

interface PutMessageResult {
  putMessage: {
    error: { __typename?: string } | null;
    messages: unknown[] | null;
  } | null;
}

export function registerChatTools(server: McpServer, client: RemindClient): void {
  server.registerTool(
    'remind_list_chats',
    {
      description:
        'List conversation streams with unread counts, member counts, last-updated time and the ' +
        'per-stream permissions (notably `canSend`). Filter to specific uuids, a class, or a search string.',
      annotations: toolAnnotations({ title: 'Remind list chats', readOnly: true, idempotent: true }),
      inputSchema: z.object({
        uuids: z.array(z.string()).optional().describe('Restrict to these chat stream uuids.'),
        class_id: z.number().int().optional().describe('Numeric class id to scope chats to.'),
        query: z.string().optional().describe('Search chats by participant/title.'),
      }),
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
      inputSchema: z.object({
        uuids: z.array(z.string()).min(1).describe('Chat stream uuids, from remind_list_chats.'),
        limit: z.number().int().min(1).max(200).default(25).describe('Max non-gap messages per stream.'),
      }),
    },
    async ({ uuids, limit }) => minifiedResult(await client.graphql(CHAT_MESSAGES, { chatUuids: uuids, limit })),
  );

  server.registerTool(
    'remind_send_message',
    {
      description:
        'Send a message to a chat stream or class. Delivers to real people and CANNOT be unsent. ' +
        'Nothing is sent until confirmed; the preview shows the exact payload. ' +
        'Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE). ' +
        'Check `permissions.canSend` on the target first (remind_list_chats).',
      annotations: toolAnnotations({ title: 'Remind send message', readOnly: false, destructive: true }),
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
      const wouldSend = { mutation: 'putMessage', input };
      const gate = await requireConfirmationWithFallback(
        ctx,
        confirmationFromEnv({
          action: 'chat.send_message',
          message: 'Review and confirm this message. It delivers to real recipients and cannot be unsent:',
          details: wouldSend,
          tool: 'remind_send_message',
          confirmToken,
          subject: () => ({
            target: recipient_uuid,
            payload: wouldSend,
            preview: { wouldSend, warning: 'This delivers to real recipients and cannot be unsent.' },
          }),
        }),
      );
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
