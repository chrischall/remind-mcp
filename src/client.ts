import { McpToolError, truncateErrorMessage } from '@chrischall/mcp-utils';
import {
  CookieSessionManager,
  createFileStatePersistence,
  resolveStateFile,
} from '@chrischall/mcp-utils/session';
import { ME_PROBE } from './queries.js';
import {
  REMIND_ORIGIN,
  captureRemindHeaders,
  createRemindTransport,
  sessionFromEnv,
  type HeaderCapturer,
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

/**
 * How long a captured session may be reused from the cache before the browser
 * is asked for a fresh one. Long enough that an overnight cold start never
 * needs the tab; short enough that a cached jar does not outlive the browser
 * session it was lifted from indefinitely.
 */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One GraphQL round-trip plus the verdict on whether it proved the session dead. */
interface Attempt {
  res: GraphQLResponse;
  expired: boolean;
}

export interface RemindClientOpts {
  /** Injectable for tests. Defaults to a receiver-safe wrapper around global fetch. */
  fetchImpl?: Fetch;
  /**
   * Replace the whole bridge bootstrap: return a session directly and no
   * transport is ever constructed.
   *
   * **Takes precedence over {@link transportFactory}** — supply one or the
   * other, not both. This one short-circuits the bootstrap entirely, so a
   * `transportFactory` passed alongside it is never reached.
   */
  captureSession?: () => Promise<RemindSession>;
  /**
   * Replace only the transport the bootstrap lifts headers from, keeping the
   * real capture logic. Ignored when {@link captureSession} is also given.
   */
  transportFactory?: () => Promise<{ server: HeaderCapturer; close: () => Promise<void> }>;
  /**
   * Where the captured session is cached between runs. Defaults to
   * `$MCP_DATA_DIR`/`$HOME`; pass `null` to disable persistence entirely
   * (tests, and anyone who would rather re-capture each time).
   */
  sessionFile?: string | null;
}

export class RemindClient {
  private readonly fetchImpl: Fetch;
  private readonly sessions: CookieSessionManager<RemindSession, Attempt>;
  private readonly transportFactory: NonNullable<RemindClientOpts['transportFactory']>;
  /** Sessions already shown (this process) to authenticate as their bound account. */
  private readonly verified = new WeakSet<RemindSession>();

  constructor(opts: RemindClientOpts = {}) {
    this.transportFactory = opts.transportFactory ?? (() => createRemindTransport());
    // A bare `fetch` reference called as `this.fetchImpl(...)` binds the wrong
    // receiver and throws "Illegal invocation" on older undici. Wrap it.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    const capture = opts.captureSession ?? (() => this.bootstrapViaBridge());
    this.sessions = new CookieSessionManager<RemindSession, Attempt>({
      // A captured session is stamped with the account it authenticates as, so
      // a cached copy can later be checked against that account (attempt()).
      // An env session is the operator's explicit choice and is left unbound.
      login: async () => sessionFromEnv() ?? (await this.bindAccount(await capture())),
      maxAgeMs: SESSION_MAX_AGE_MS,
      // Expiry is decided inside the call (see attempt()), where the session is
      // in hand to probe with; invalidating on any Unauthorized would discard a
      // valid persisted session whenever a parent touched a teacher-only field.
      isExpired: (attempt) => attempt.expired,
      // Without this the bridge capture re-runs on every cold start, and that
      // capture can only complete while the signed-in tab happens to make a
      // /graphql request — so a hosted child restarting overnight would hang
      // rather than reconnect. Cached, the browser is needed once.
      persistence: opts.sessionFile === null ? undefined : createFileStatePersistence({
        filePath:
          opts.sessionFile ??
          resolveStateFile({ envVar: 'REMIND_SESSION_FILE', fileName: 'session.json', subdir: '.remind-mcp' }),
        // Only an account-bound record is restorable: an unbound one (an env
        // session, a legacy file, a capture whose `me` probe failed) cannot be
        // shown to belong to anyone, so it is re-captured instead. A record with
        // no clock counts as infinitely old rather than freshly minted.
        validate: (raw) => {
          const r = raw as { session?: Partial<RemindSession>; sessionAt?: number } | null;
          if (!r?.session?.cookie || !r.session.csrfToken || !r.session.accountUuid) return null;
          return { session: r.session as RemindSession, sessionAt: r.sessionAt ?? 0 };
        },
      }),
    });
  }

  /**
   * One-time credential lift from the signed-in tab; not on the hot path.
   * Both headers ride the SAME next request, so the two captures must be armed
   * concurrently — awaiting them in series would arm the second only after the
   * request that satisfied the first had already gone by.
   */
  private async bootstrapViaBridge(): Promise<RemindSession> {
    const transport = await this.transportFactory();
    try {
      return await captureRemindHeaders(transport.server);
    } finally {
      await transport.close().catch(() => {});
    }
  }

  /** Stamp a freshly captured session with its `me.uuid`; unbound if that cannot be read. */
  private async bindAccount(session: RemindSession): Promise<RemindSession> {
    let accountUuid: string | undefined;
    try {
      const probe = await this.post<{ me?: { uuid?: string } | null }>(session, ME_PROBE, {});
      if (!isUnauthorized(probe)) accountUuid = probe.data?.me?.uuid ?? undefined;
    } catch {
      // Leave it unbound: usable now, but never restored from the cache.
    }
    const bound: RemindSession = { ...session, accountUuid };
    if (!accountUuid) delete bound.accountUuid;
    this.verified.add(bound);
    return bound;
  }

  /** Run a GraphQL document, replaying exactly once if the session expired. */
  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const { res } = await this.sessions.withSession((session) => this.attempt(session, query, variables));
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

  /**
   * Run the document and judge whether an `Unauthorized` means the session is
   * dead. Remind uses the same error for a field this account may not use, so
   * an error scoped to a field other than `me` is checked against a minimal
   * `me` probe on the same session: only if that is also refused is it expiry.
   */
  private async attempt(
    session: RemindSession,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Attempt> {
    // A session restored from the cache is used only once a `me` probe shows it
    // still authenticates as the account it was captured for. Anything else —
    // another account, or no account — is treated as expiry and re-captured.
    if (session.accountUuid && !this.verified.has(session)) {
      const probe = await this.post<{ me?: { uuid?: string } | null }>(session, ME_PROBE, {});
      if (probe.data?.me?.uuid !== session.accountUuid) {
        return { res: { errors: [{ message: 'Unauthorized' }] }, expired: true };
      }
      this.verified.add(session);
    }
    const res = await this.post(session, query, variables);
    if (!isUnauthorized(res)) return { res, expired: false };
    const sessionWide = (res.errors ?? []).some(
      (e) => isUnauthorized({ errors: [e] }) && (!e.path?.length || e.path[0] === 'me'),
    );
    if (sessionWide) return { res, expired: true };
    let probe: GraphQLResponse<{ me?: { uuid?: string } | null }>;
    try {
      probe = await this.post(session, ME_PROBE, {});
    } catch {
      // Could not tell; keep the session and surface the original error.
      return { res, expired: false };
    }
    return { res, expired: isUnauthorized(probe) || !probe.data?.me?.uuid };
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
