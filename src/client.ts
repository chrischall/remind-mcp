import { McpToolError, truncateErrorMessage } from '@chrischall/mcp-utils';
import { CookieSessionManager } from '@chrischall/mcp-utils/session';
import {
  REMIND_ORIGIN,
  captureRemindHeaders,
  createRemindTransport,
  sessionFromEnv,
  type RemindSession,
} from './session.js';

export interface GraphQLError {
  message: string;
  path?: (string | number)[];
  extensions?: { code?: string };
}
export interface GraphQLResponse<T = unknown> {
  data?: T | null;
  errors?: GraphQLError[];
}

/**
 * Remind answers an expired session with **HTTP 200** and a GraphQL error whose
 * message is `Unauthorized`, so expiry cannot be read off the status code. It
 * also returns that same shape for a field the *account* may not use (a parent
 * account asking for a teacher-only query), which is NOT an expiry — hence the
 * distinction below is drawn on the top-level `me` probe, not on any error.
 */
export function isUnauthorized(res: GraphQLResponse): boolean {
  return (res.errors ?? []).some(
    (e) => e.message === 'Unauthorized' || e.extensions?.code === 'unauthorized',
  );
}

type Fetch = typeof globalThis.fetch;

export interface RemindClientOpts {
  /** Injectable for tests. Defaults to a receiver-safe wrapper around global fetch. */
  fetchImpl?: Fetch;
  /** Injectable bridge bootstrap, so tests never construct a real transport. */
  captureSession?: () => Promise<RemindSession>;
}

export class RemindClient {
  private readonly fetchImpl: Fetch;
  private readonly sessions: CookieSessionManager<RemindSession, GraphQLResponse>;

  constructor(opts: RemindClientOpts = {}) {
    // A bare `fetch` reference called as `this.fetchImpl(...)` binds the wrong
    // receiver and throws "Illegal invocation" on older undici. Wrap it.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    const capture = opts.captureSession ?? (() => this.bootstrapViaBridge());
    this.sessions = new CookieSessionManager<RemindSession, GraphQLResponse>({
      login: async () => sessionFromEnv() ?? (await capture()),
      isExpired: (res) => isUnauthorized(res),
    });
  }

  /**
   * One-time credential lift from the signed-in tab; not on the hot path.
   * Both headers ride the SAME next request, so the two captures must be armed
   * concurrently — awaiting them in series would arm the second only after the
   * request that satisfied the first had already gone by.
   */
  private async bootstrapViaBridge(): Promise<RemindSession> {
    const transport = await createRemindTransport();
    try {
      return await captureRemindHeaders(transport.server);
    } finally {
      await transport.close().catch(() => {});
    }
  }

  /** Run a GraphQL document, replaying exactly once if the session expired. */
  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await this.sessions.withSession((session) => this.post<T>(session, query, variables));
    if (res.errors?.length) {
      const first = res.errors[0];
      if (isUnauthorized(res)) {
        throw new McpToolError('Remind rejected the request as unauthorized.', {
          hint:
            'Either the captured session expired, or this account lacks access to that data ' +
            '(scheduled messages and org admin queries are owner/teacher-only). ' +
            `Open ${REMIND_ORIGIN} in Chrome while signed in and retry.`,
        });
      }
      throw new McpToolError(
        truncateErrorMessage(`Remind GraphQL error: ${first.message}`),
        { hint: first.path ? `Failed at: ${first.path.join('.')}` : undefined },
      );
    }
    if (res.data == null) throw new McpToolError('Remind returned no data for that query.');
    return res.data as T;
  }

  private async post<T>(
    session: RemindSession,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GraphQLResponse<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${REMIND_ORIGIN}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          cookie: session.cookie,
          'x-csrf-token': session.csrfToken,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      throw new McpToolError(
        `Could not reach ${REMIND_ORIGIN}/graphql${code ? ` (${code})` : ''}.`,
        { cause: err, hint: 'Check network access and that remind.com egress is allowed.' },
      );
    }
    const text = await response.text();
    let parsed: GraphQLResponse<T>;
    try {
      parsed = JSON.parse(text) as GraphQLResponse<T>;
    } catch {
      // A non-JSON 2xx here is an interstitial or an HTML error page.
      throw new McpToolError(
        `Remind returned non-JSON (HTTP ${response.status}) for a GraphQL call.`,
        { hint: 'Usually a signed-out session — reload remind.com in Chrome and retry.' },
      );
    }
    if (!response.ok && !parsed.errors) {
      throw new McpToolError(`Remind GraphQL HTTP ${response.status}.`);
    }
    return parsed;
  }
}
