import { McpToolError, readEnvVar, readPortEnv } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';

/** Remind's apex; every page and the GraphQL endpoint live under `www.`. */
export const REMIND_APEX = 'remind.com';
export const REMIND_HOST = 'www.remind.com';
export const REMIND_ORIGIN = `https://${REMIND_HOST}`;
/** The whole fetchproxy fleet shares one concentrator port. */
export const DEFAULT_WS_PORT = 37_149;

/**
 * The credential Remind's web app actually presents on every GraphQL call:
 * the full `Cookie` request header plus the CSRF token echoed back in
 * `x-csrf-token`. Both are lifted verbatim from a signed-in tab — the named
 * cookie read comes back empty on this site, so header capture is the only
 * route (see docs/REMIND-API.md).
 */
export interface RemindSession {
  cookie: string;
  csrfToken: string;
  capturedAt: string;
}

/** Shape of the `session` payload the fetchproxy bootstrap returns. */
interface CapturedSession {
  capturedHeaders?: Record<string, string | undefined>;
}

/** The slice of a fetchproxy server the bootstrap actually uses. */
export interface HeaderCapturer {
  captureRequestHeader(opts: { host: string; path: string; headerName: string }): Promise<string>;
}

/**
 * Lift both auth headers off the SAME next request. They must be armed
 * concurrently: awaiting them in series arms the second only after the request
 * that satisfied the first has already gone by, so it would hang until the
 * page happened to make another call.
 */
export async function captureRemindHeaders(server: HeaderCapturer): Promise<RemindSession> {
  const arm = (headerName: string) =>
    server.captureRequestHeader({ host: REMIND_HOST, path: '/graphql*', headerName });
  const [cookie, csrf] = await Promise.all([arm('cookie'), arm('x-csrf-token')]);
  return sessionFromCapture({ capturedHeaders: { cookie, 'x-csrf-token': csrf } });
}

export function sessionFromCapture(captured: CapturedSession): RemindSession {
  const cookie = captured.capturedHeaders?.['cookie'];
  const csrfToken = captured.capturedHeaders?.['x-csrf-token'];
  if (!cookie || !csrfToken) {
    const missing = [!cookie && 'cookie', !csrfToken && 'x-csrf-token'].filter(Boolean).join(' and ');
    throw new McpToolError(`Remind bootstrap captured no ${missing} header.`, {
      hint:
        `Open ${REMIND_ORIGIN} in Chrome, make sure you are signed in, then retry — ` +
        'the capture completes on the next request the page makes, so a reload feeds it.',
    });
  }
  return { cookie, csrfToken, capturedAt: new Date().toISOString() };
}

/**
 * Bootstrap options: capture the two auth headers, nothing else.
 *
 * `@chrischall/mcp-utils/fetchproxy` pulls in `@fetchproxy/server`, which the
 * bundle marks `--external` and the `.mcpb` therefore ships WITHOUT. A
 * top-level import would throw ERR_MODULE_NOT_FOUND the moment a host spawns
 * the bundled server — before it can answer `initialize`. So the bridge is
 * imported lazily, and only the credential-capture path ever touches it.
 */
async function fetchproxyModule(): Promise<typeof import('@chrischall/mcp-utils/fetchproxy')> {
  // The specifier is held in a variable so esbuild cannot statically analyse
  // (and therefore inline) this import — an inlined one hoists the external
  // `@fetchproxy/server` back to the top level, which is the very crash this
  // avoids. Kept as a genuine runtime import instead.
  const specifier = '@chrischall/mcp-utils/fetchproxy';
  try {
    return (await import(specifier)) as typeof import('@chrischall/mcp-utils/fetchproxy');
  } catch (cause) {
    throw new McpToolError('The fetchproxy browser bridge is not available in this build.', {
      cause,
      hint:
        'The .mcpb bundle ships without the bridge. Capture a session in a full install ' +
        '(npx @chrischall/remind-mcp) and supply REMIND_COOKIE and REMIND_CSRF_TOKEN instead.',
    });
  }
}

export async function remindBootstrapOpts() {
  const { createBootstrapOpts } = await fetchproxyModule();
  return createBootstrapOpts({
    domains: REMIND_APEX,
    storageDomain: REMIND_HOST,
    bootstrap: {
      captureHeaders: [
        { host: REMIND_HOST, path: '/graphql*', headerName: 'cookie' },
        { host: REMIND_HOST, path: '/graphql*', headerName: 'x-csrf-token' },
      ],
    },
  });
}

export async function createRemindTransport() {
  const { createFetchproxyTransport } = await fetchproxyModule();
  return createFetchproxyTransport({
    ...(await remindBootstrapOpts()),
    serverName: 'remind-mcp',
    version: VERSION,
    port: readPortEnv('REMIND_WS_PORT', DEFAULT_WS_PORT),
  });
}

/** An operator can paste a captured session instead of running the bridge. */
export function sessionFromEnv(): RemindSession | undefined {
  const cookie = readEnvVar('REMIND_COOKIE');
  const csrfToken = readEnvVar('REMIND_CSRF_TOKEN');
  if (!cookie || !csrfToken) return undefined;
  return { cookie, csrfToken, capturedAt: new Date().toISOString() };
}
