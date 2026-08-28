import { describe, it, expect, vi } from 'vitest';
import { RemindClient, isUnauthorized } from '../src/client.js';
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

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
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
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? jsonResponse({ errors: [{ message: 'Unauthorized' }] })
        : jsonResponse({ data: { me: { uuid: 'u1' } } });
    });
    const captureSession = vi.fn(capture);
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession, sessionFile: null });
    await expect(client.graphql('{ me { uuid } }')).resolves.toEqual({ me: { uuid: 'u1' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

  it('accepts a stored record with no sessionAt clock', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const sessionFile = join(mkdtempSync(join(tmpdir(), 'remind-noclock-')), 'session.json');
    writeFileSync(sessionFile, JSON.stringify({
      v: 1, state: { session: { cookie: 'a=1', csrfToken: 'tok', capturedAt: 'now' } },
    }));
    const captureSession = vi.fn(capture);
    const client = new RemindClient({
      fetchImpl: vi.fn(async () => jsonOk()) as never, captureSession, sessionFile,
    });
    await client.graphql('{ me { uuid } }');
    expect(captureSession).not.toHaveBeenCalled();
  });
});
