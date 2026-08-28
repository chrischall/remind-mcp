import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, McpToolError } from '@chrischall/mcp-utils';
import type { RemindClient } from '../client.js';
import { ME } from '../queries.js';

/** Mutations must go through the confirm-gated tools, never the escape hatch. */
const MUTATION_RE = /(^|[\s{])mutation\b/i;

export function registerRawTools(server: McpServer, client: RemindClient): void {
  server.registerTool(
    'remind_graphql',
    {
      description:
        "Run an arbitrary READ-ONLY GraphQL query against Remind's API. Introspection is enabled, so " +
        '`{ __schema { ... } }` and `{ __type(name:"Class") { fields { name } } }` work for discovering ' +
        'fields the typed tools do not expose. Mutations are rejected — use the confirm-gated write tools. ' +
        'Note: Remind reports an unknown field as a 500-backed GRAPHQL_VALIDATION_FAILED, not a field error.',
      annotations: toolAnnotations({ title: 'Remind raw GraphQL', readOnly: true }),
      inputSchema: {
        query: z.string().min(1).describe('A GraphQL query document.'),
        variables: z.record(z.string(), z.unknown()).optional().describe('Variables for the document.'),
      },
    },
    async ({ query, variables }) => {
      if (MUTATION_RE.test(query)) {
        throw new McpToolError('remind_graphql is read-only; mutations are refused.', {
          hint: 'Use remind_send_message or remind_set_notification_devices, which are confirm-gated.',
        });
      }
      return textResult(await client.graphql(query, variables ?? {}));
    },
  );

  server.registerTool(
    'remind_healthcheck',
    {
      description:
        'Verify the Remind session end-to-end by running the smallest authenticated query. Reports whether ' +
        'the captured browser session still authenticates.',
      annotations: toolAnnotations({ title: 'Remind healthcheck', readOnly: true, idempotent: true }),
      inputSchema: {},
    },
    async () => {
      const data = await client.graphql<{ me: { uuid: string } | null }>(ME);
      return textResult({ ok: Boolean(data.me?.uuid), account: data.me });
    },
  );
}
