import { z } from 'zod';
import { Kind, parse } from 'graphql';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { runCredentialHealthcheck } from '@chrischall/mcp-utils/healthcheck';
import { RemindUnauthorizedError, type RemindClient } from '../client.js';
import { REMIND_HOST, sessionFromEnv } from '../session.js';
import { ME } from '../queries.js';

/**
 * Mutations must go through the typed write tools, which preview the change and
 * ask for confirmation first, never the escape hatch.
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
        'fields the typed tools do not expose. Mutations are rejected — use the write tools, which preview ' +
        'the change and ask you to confirm first. ' +
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
          hint:
            'Use remind_send_message or remind_set_notification_devices, which preview the change and ' +
            'ask for confirmation before sending.',
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
        'the captured browser session still authenticates, and when it does not, which hop broke as ' +
        '`error.kind`: no_credential (no session could be captured), credential_rejected (Remind refused ' +
        'the session), edge_blocked (a CDN/WAF refused the request before Remind saw it — re-signing in ' +
        'will not help), http, timeout or transport. Read-only; never returns the cookie or CSRF token.',
      annotations: toolAnnotations({ title: 'Remind healthcheck', readOnly: true, idempotent: true }),
      inputSchema: z.object({}),
    },
    async () => {
      let account: { uuid: string } | null = null;
      const result = await runCredentialHealthcheck({
        server,
        prefix: 'remind',
        hostLabel: REMIND_HOST,
        probePath: '/graphql',
        // The session itself is resolved lazily by the probe (env, cache, then
        // the browser bridge) exactly as every real tool resolves it.
        resolveCredential: async () => ({ source: sessionFromEnv() ? 'env' : 'browser-session' }),
        probeFn: async () => {
          const data = await client.graphql<{ me: { uuid: string } | null }>(ME);
          if (!data.me?.uuid) {
            throw new RemindUnauthorizedError('Remind answered without an account; the session is not signed in.');
          }
          account = data.me;
        },
        classifyThrown: (err) =>
          err instanceof McpToolError && /bootstrap captured no/i.test(err.message)
            ? { kind: 'no_credential', hint: err.hint }
            : undefined,
      });
      const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
      return minifiedResult({ ...body, account });
    },
  );
}
