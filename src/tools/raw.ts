import { z } from 'zod';
import { Kind, parse } from 'graphql';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { RemindClient } from '../client.js';
import { ME } from '../queries.js';

/**
 * Mutations must go through the confirm-gated tools, never the escape hatch.
 * The document is parsed rather than pattern-matched: GraphQL treats commas,
 * comments and a BOM as ignored tokens and lets an operation follow `}`
 * directly, so a regex over the raw text is trivially sidestepped
 * (`,mutation M { ... }`). Anything that is not solely query operations (plus
 * fragments) is refused, including a document that does not parse at all.
 */
export function readOnlyViolation(query: string): string | null {
  let doc;
  try {
    doc = parse(query, { noLocation: true });
  } catch (err) {
    return `the document does not parse (${(err as Error).message})`;
  }
  for (const def of doc.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) {
      if (def.operation !== 'query') return `it contains a ${def.operation} operation`;
    } else if (def.kind !== Kind.FRAGMENT_DEFINITION) {
      return `it contains a ${def.kind} definition`;
    }
  }
  return null;
}

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
      inputSchema: z.object({
        query: z.string().min(1).describe('A GraphQL query document.'),
        variables: z.record(z.string(), z.unknown()).optional().describe('Variables for the document.'),
      }),
    },
    async ({ query, variables }) => {
      const violation = readOnlyViolation(query);
      if (violation) {
        throw new McpToolError(`remind_graphql is read-only; refused because ${violation}.`, {
          hint: 'Use remind_send_message or remind_set_notification_devices, which are confirm-gated.',
        });
      }
      return minifiedResult(await client.graphql(query, variables ?? {}));
    },
  );

  server.registerTool(
    'remind_healthcheck',
    {
      description:
        'Verify the Remind session end-to-end by running the smallest authenticated query. Reports whether ' +
        'the captured browser session still authenticates.',
      annotations: toolAnnotations({ title: 'Remind healthcheck', readOnly: true, idempotent: true }),
      inputSchema: z.object({}),
    },
    async () => {
      const data = await client.graphql<{ me: { uuid: string } | null }>(ME);
      return minifiedResult({ ok: Boolean(data.me?.uuid), account: data.me });
    },
  );
}
