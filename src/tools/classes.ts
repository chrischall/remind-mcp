import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { RemindClient } from '../client.js';
import { CLASSES, NAVIGATION_LIST } from '../queries.js';

export function registerClassTools(server: McpServer, client: RemindClient): void {
  server.registerTool(
    'remind_list_entities',
    {
      description:
        'List everything in the Remind sidebar — classes and chats — as the app itself renders it, ' +
        'with unread counts. This is the entry point: it yields the uuids the other tools take. ' +
        'Optionally filter with a search query, and page with the returned cursor.',
      annotations: toolAnnotations({ title: 'Remind list classes & chats', readOnly: true, idempotent: true }),
      inputSchema: {
        query: z.string().optional().describe('Filter by name.'),
        cursor: z.string().optional().describe('`cursor` from a previous call, to page.'),
      },
    },
    async ({ query, cursor }) =>
      textResult(await client.graphql(NAVIGATION_LIST, { query: query ?? null, lastCursor: cursor ?? null })),
  );

  server.registerTool(
    'remind_get_classes',
    {
      description:
        'Get full detail for one or more classes by uuid: name, join code/url, member and message counts, ' +
        'owner count, history and messaging flags, and what this account may edit.',
      annotations: toolAnnotations({ title: 'Remind get classes', readOnly: true, idempotent: true }),
      inputSchema: {
        uuids: z.array(z.string()).min(1).describe('Class uuids, from remind_list_entities.'),
      },
    },
    async ({ uuids }) => textResult(await client.graphql(CLASSES, { uuids })),
  );
}
