import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemindClient, SESSION_MAX_AGE_MS, isUnauthorized } from '../src/client.js';
import type { RemindSession } from '../src/session.js';

const SESSION: RemindSession = { cookie: 'a=1; b=2', csrfToken: 'tok-123', capturedAt: 'now' };
const capture = () => Promise.resolve(SESSION);

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('isUnauthorized', () => {
  it('matches on the message Remind actually returns', () => {
    expect(isUnauthorized({ errors: [{ message: 'Unauthorized' }] })).toBe(true);
  });
  it('matches on the extensions code', () => {
    expect(isUnauthorized({ errors: [{ message: 'nope', extensions: { code: 'unauthorized' } }] })).toBe(true);
  });
  it('is false for an ordinary error and for a clean response', () => {
    expect(isUnauthorized({ errors: [{ message: 'Internal service error' }] })).toBe(false);
    expect(isUnauthorized({ data: { me: null } })).toBe(false);
  });
});

describe('RemindClient.graphql', () => {
  it('sends the cookie and x-csrf-token headers Remind requires', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { me: { uuid: 'u1' } } }));
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture, sessionFile: null });
    await client.graphql('{ me { uuid } }');

    // The last call is the caller's query (a `me` probe stamps the account first).
    const [url, init] = fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe('https://www.remind.com/graphql');
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe(SESSION.cookie);
    expect(headers['x-csrf-token']).toBe(SESSION.csrfToken);
    expect(JSON.parse(init.body as string)).toEqual({ query: '{ me { uuid } }', variables: {} });
  });

  it('returns data on success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { me: { uuid: 'u1' } } }));
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture, sessionFile: null });
    await expect(client.graphql('{ me { uuid } }')).resolves.toEqual({ me: { uuid: 'u1' } });
  });

  it('re-captures the session exactly once when Remind reports Unauthorized', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      if (query.includes('RemindMeProbe')) return jsonResponse({ data: { me: { uuid: 'u1' } } });
      call += 1;
      return call === 1
        ? jsonResponse({ errors: [{ message: 'Unauthorized' }] })
        : jsonResponse({ data: { me: { uuid: 'u1' } } });
    });
    const captureSession = vi.fn(capture);
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession, sessionFile: null });
    await expect(client.graphql('{ me { uuid } }')).resolves.toEqual({ me: { uuid: 'u1' } });
    expect(call).toBe(2);
    expect(captureSession).toHaveBeenCalledTimes(2);
  });

  it('keeps the session when an Unauthorized is scoped to a field the account may not use', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remind-mcp-'));
    const sessionFile = join(dir, 'session.json');
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      bodies.push(query);
      return query.includes('scheduledMessages')
        ? jsonResponse({ data: null, errors: [{ message: 'Unauthorized', path: ['scheduledMessages'] }] })
        : jsonResponse({ data: { me: { uuid: 'u1' } } });
    });
    const captureSession = vi.fn(capture);
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession, sessionFile });
    await expect(client.graphql('{ scheduledMessages { uuid } }')).rejects.toThrow(/unauthorized/i);
    // The `me` probe proved the session still authenticates: no re-capture, no replay…
    expect(captureSession).toHaveBeenCalledTimes(1);
    expect(bodies.filter((q) => q.includes('scheduledMessages'))).toHaveLength(1);
    // …and the persisted session survives for the next process.
    await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(sessionFile)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the session and surfaces the original error when the me probe cannot be made', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      if (query.includes('RemindMeProbe')) throw Object.assign(new Error('fail'), { cause: { code: 'ECONNRESET' } });
      return jsonResponse({ data: null, errors: [{ message: 'Unauthorized', path: ['scheduledMessages'] }] });
    });
    const captureSession = vi.fn(capture);
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession, sessionFile: null });
    await expect(client.graphql('{ scheduledMessages { uuid } }')).rejects.toThrow(/unauthorized/i);
    expect(captureSession).toHaveBeenCalledTimes(1);
  });

  it('re-captures when a field-scoped Unauthorized turns out to be a real expiry', async () => {
    let expired = true;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      if (expired) {
        return jsonResponse({ data: null, errors: [{ message: 'Unauthorized', path: [query.includes('classes') ? 'classes' : 'me'] }] });
      }
      return jsonResponse({ data: { classes: [] } });
    });
    const captureSession = vi.fn(async () => {
      if (captureSession.mock.calls.length > 1) expired = false;
      return SESSION;
    });
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession, sessionFile: null });
    await expect(client.graphql('{ classes { uuid } }')).resolves.toEqual({ classes: [] });
    expect(captureSession).toHaveBeenCalledTimes(2);
  });

  it('throws an actionable error when the replay is still unauthorized', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'Unauthorized' }] }));
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture, sessionFile: null });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/unauthorized/i);
  });

  it('surfaces an ordinary GraphQL error message', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ message: 'Internal service error', path: ['me', 'bogus'] }] }),
    );
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture, sessionFile: null });
    await expect(client.graphql('{ me { bogus } }')).rejects.toThrow(/Internal service error/);
  });

  it('explains a non-JSON body rather than throwing a parse error', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>signed out</html>', { status: 200 }));
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture, sessionFile: null });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/non-JSON/);
  });

  it('reports a network failure with its cause code', async () => {
    const err = Object.assign(new Error('fail'), { cause: { code: 'ENOTFOUND' } });
    const fetchImpl = vi.fn(async () => { throw err; });
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture, sessionFile: null });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/ENOTFOUND/);
  });

  it('throws when the response carries neither data nor errors', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: null }));
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture, sessionFile: null });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/no data/);
  });

  it('reports a non-2xx with no GraphQL error body as an HTTP failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: null }, 502));
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture, sessionFile: null });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/HTTP 502/);
  });
});

describe('bridge bootstrap', () => {
  const jsonOk = () => new Response(JSON.stringify({ data: { me: { uuid: 'u1' } } }),
    { status: 200, headers: { 'content-type': 'application/json' } });

  it('lifts both headers off the transport and always closes it', async () => {
    const close = vi.fn(async () => {});
    const transportFactory = vi.fn(async () => ({
      server: { captureRequestHeader: async ({ headerName }: { headerName: string }) =>
        headerName === 'cookie' ? 'a=1' : 'tok' },
      close,
    }));
    const fetchImpl = vi.fn(async () => jsonOk());
    const client = new RemindClient({ fetchImpl: fetchImpl as never, transportFactory, sessionFile: null });
    await client.graphql('{ me { uuid } }');

    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers.cookie).toBe('a=1');
    expect(headers['x-csrf-token']).toBe('tok');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the transport even when the capture fails', async () => {
    const close = vi.fn(async () => {});
    const transportFactory = vi.fn(async () => ({
      server: { captureRequestHeader: async () => { throw new Error('bridge down'); } },
      close,
    }));
    const client = new RemindClient({ fetchImpl: vi.fn() as never, transportFactory, sessionFile: null });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/bridge down/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('prefers an env-supplied session and never touches the bridge', async () => {
    process.env.REMIND_COOKIE = 'env=1';
    process.env.REMIND_CSRF_TOKEN = 'envtok';
    const transportFactory = vi.fn();
    const fetchImpl = vi.fn(async () => jsonOk());
    try {
      const client = new RemindClient({ fetchImpl: fetchImpl as never, transportFactory: transportFactory as never, sessionFile: null });
      await client.graphql('{ me { uuid } }');
      expect(transportFactory).not.toHaveBeenCalled();
      const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
        .headers as Record<string, string>;
      expect(headers.cookie).toBe('env=1');
    } finally {
      delete process.env.REMIND_COOKIE;
      delete process.env.REMIND_CSRF_TOKEN;
    }
  });
});

describe('injection seam precedence', () => {
  it('captureSession wins and the transportFactory is never constructed', async () => {
    // Documented precedence: captureSession short-circuits the bootstrap, so a
    // transportFactory passed alongside it must not be reached.
    const transportFactory = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { me: { uuid: 'u1' } } }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new RemindClient({
      fetchImpl: fetchImpl as never,
      captureSession: capture,
      transportFactory: transportFactory as never, sessionFile: null });
    await client.graphql('{ me { uuid } }');
    expect(transportFactory).not.toHaveBeenCalled();
  });
});

describe('session persistence', () => {
  const jsonOk = () => new Response(JSON.stringify({ data: { me: { uuid: 'u1' } } }),
    { status: 200, headers: { 'content-type': 'application/json' } });

  it('captures once, then reuses the cached session on a fresh client', async () => {
    // This is what makes bridge-based hosting workable: a cold-started child
    // must not need the browser again, because the capture only completes
    // while the signed-in tab happens to issue a /graphql request.
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const sessionFile = join(mkdtempSync(join(tmpdir(), 'remind-sess-')), 'session.json');

    const captureSession = vi.fn(capture);
    const fetchImpl = vi.fn(async () => jsonOk());

    const first = new RemindClient({ fetchImpl: fetchImpl as never, captureSession, sessionFile });
    await first.graphql('{ me { uuid } }');
    expect(captureSession).toHaveBeenCalledTimes(1);

    // A brand-new client == a restarted child.
    const captureAgain = vi.fn(capture);
    const second = new RemindClient({
      fetchImpl: fetchImpl as never, captureSession: captureAgain, sessionFile,
    });
    await second.graphql('{ me { uuid } }');
    expect(captureAgain).not.toHaveBeenCalled();

    const fs = await import('node:fs');
    const stored = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    expect(stored.state.session.cookie).toBe(SESSION.cookie);
    // Bound to the account the capture authenticated as.
    expect(stored.state.session.accountUuid).toBe('u1');
    // It holds a live credential, so it must not be world-readable.
    expect(fs.statSync(sessionFile).mode & 0o077).toBe(0);
  });

  it('rejects a stored record missing either credential half', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const sessionFile = join(mkdtempSync(join(tmpdir(), 'remind-bad-')), 'session.json');
    writeFileSync(sessionFile, JSON.stringify({ session: { cookie: 'a=1' }, sessionAt: Date.now() }));

    const captureSession = vi.fn(capture);
    const client = new RemindClient({
      fetchImpl: vi.fn(async () => jsonOk()) as never, captureSession, sessionFile,
    });
    await client.graphql('{ me { uuid } }');
    // Half a credential is not a session — fall through to a real capture.
    expect(captureSession).toHaveBeenCalledTimes(1);
  });
});

describe('default session-file resolution', () => {
  const jsonOk = () => new Response(JSON.stringify({ data: { me: { uuid: 'u1' } } }),
    { status: 200, headers: { 'content-type': 'application/json' } });

  it('honours REMIND_SESSION_FILE when no path is passed', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'remind-env-')), 'session.json');
    process.env.REMIND_SESSION_FILE = file;
    try {
      const client = new RemindClient({ fetchImpl: vi.fn(async () => jsonOk()) as never, captureSession: capture });
      await client.graphql('{ me { uuid } }');
      expect(existsSync(file)).toBe(true);
    } finally {
      delete process.env.REMIND_SESSION_FILE;
    }
  });

  it('rejects a legacy stored record that is not bound to an account', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const sessionFile = join(mkdtempSync(join(tmpdir(), 'remind-legacy-')), 'session.json');
    writeFileSync(sessionFile, JSON.stringify({
      v: 1, state: { session: { cookie: 'a=1', csrfToken: 'tok', capturedAt: 'now' }, sessionAt: Date.now() },
    }));
    const captureSession = vi.fn(capture);
    const client = new RemindClient({
      fetchImpl: vi.fn(async () => jsonOk()) as never, captureSession, sessionFile,
    });
    await client.graphql('{ me { uuid } }');
    expect(captureSession).toHaveBeenCalledTimes(1);
  });
});

describe('account binding and expiry of the cached session', () => {
  const tmpFile = (prefix: string) => join(mkdtempSync(join(tmpdir(), prefix)), 'session.json');
  const OTHER: RemindSession = { cookie: 'c=3', csrfToken: 'tok-456', capturedAt: 'now' };
  /** Answers the `me` probe per cookie jar; every other query succeeds. */
  const fetchByCookie = (uuidFor: Record<string, string>) =>
    vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      const cookie = (init.headers as Record<string, string>).cookie;
      if (query.includes('RemindMeProbe')) return jsonResponse({ data: { me: { uuid: uuidFor[cookie] } } });
      return jsonResponse({ data: { classes: [] } });
    });
  const writeRecord = (file: string, session: RemindSession & { accountUuid?: string }, sessionAt: number) =>
    import('node:fs').then(({ writeFileSync }) =>
      writeFileSync(file, JSON.stringify({ v: 1, state: { session, sessionAt } })));

  it('re-captures when a restored session now authenticates as a different account', async () => {
    const sessionFile = tmpFile('remind-bind-');
    await writeRecord(sessionFile, { ...SESSION, accountUuid: 'u1' }, Date.now());
    // The cached jar now answers as u2 — it no longer belongs to the account it was bound to.
    const fetchImpl = fetchByCookie({ [SESSION.cookie]: 'u2', [OTHER.cookie]: 'u9' });
    const captureSession = vi.fn(async () => OTHER);
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession, sessionFile });
    await expect(client.graphql('{ classes { uuid } }')).resolves.toEqual({ classes: [] });
    expect(captureSession).toHaveBeenCalledTimes(1);
    const last = fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect((last[1].headers as Record<string, string>).cookie).toBe(OTHER.cookie);
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(sessionFile, 'utf8')).state.session.accountUuid).toBe('u9');
  });

  it('verifies a restored session once per process, then trusts it', async () => {
    const sessionFile = tmpFile('remind-once-');
    await writeRecord(sessionFile, { ...SESSION, accountUuid: 'u1' }, Date.now());
    const fetchImpl = fetchByCookie({ [SESSION.cookie]: 'u1' });
    const captureSession = vi.fn(capture);
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession, sessionFile });
    await client.graphql('{ classes { uuid } }');
    await client.graphql('{ classes { uuid } }');
    expect(captureSession).not.toHaveBeenCalled();
    const probes = fetchImpl.mock.calls.filter(([, init]) =>
      (JSON.parse((init as RequestInit).body as string) as { query: string }).query.includes('RemindMeProbe'));
    expect(probes).toHaveLength(1);
  });

  it('keeps an unverifiable restored session on a transient probe failure, then verifies it next call', async () => {
    const sessionFile = tmpFile('remind-blip-');
    await writeRecord(sessionFile, { ...SESSION, accountUuid: 'u1' }, Date.now());
    const { readFileSync } = await import('node:fs');
    const before = readFileSync(sessionFile, 'utf8');
    const healthy = fetchByCookie({ [SESSION.cookie]: 'u1' });
    let down = true;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return healthy(url, init);
    });
    const captureSession = vi.fn(capture);
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession, sessionFile });

    // The blip is reported as a verification failure — neither the caller's
    // query nor a browser re-capture is attempted, and the cache is untouched.
    const err = await client.graphql('{ classes { uuid } }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Could not verify the cached Remind session/);
    expect((err as Error).message).toMatch(/ECONNRESET/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captureSession).not.toHaveBeenCalled();
    expect(readFileSync(sessionFile, 'utf8')).toBe(before);

    // Once the network is back, the same cached session verifies and is used.
    down = false;
    await expect(client.graphql('{ classes { uuid } }')).resolves.toEqual({ classes: [] });
    expect(captureSession).not.toHaveBeenCalled();
  });

  it('re-captures a cached session older than the max age', async () => {
    const sessionFile = tmpFile('remind-stale-');
    await writeRecord(sessionFile, { ...SESSION, accountUuid: 'u1' }, Date.now() - SESSION_MAX_AGE_MS - 60_000);
    const fetchImpl = fetchByCookie({ [SESSION.cookie]: 'u1' });
    const captureSession = vi.fn(capture);
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession, sessionFile });
    await client.graphql('{ classes { uuid } }');
    expect(captureSession).toHaveBeenCalledTimes(1);
  });

  it('does not bind or verify an operator-supplied env session', async () => {
    process.env.REMIND_COOKIE = 'env=1';
    process.env.REMIND_CSRF_TOKEN = 'envtok';
    try {
      const fetchImpl = fetchByCookie({ 'env=1': 'u1' });
      const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture, sessionFile: null });
      await client.graphql('{ classes { uuid } }');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.REMIND_COOKIE;
      delete process.env.REMIND_CSRF_TOKEN;
    }
  });
});
