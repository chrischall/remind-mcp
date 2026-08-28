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
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture });
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
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture });
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
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession });
    await expect(client.graphql('{ me { uuid } }')).resolves.toEqual({ me: { uuid: 'u1' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(captureSession).toHaveBeenCalledTimes(2);
  });

  it('throws an actionable error when the replay is still unauthorized', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'Unauthorized' }] }));
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/unauthorized/i);
  });

  it('surfaces an ordinary GraphQL error message', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ message: 'Internal service error', path: ['me', 'bogus'] }] }),
    );
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture });
    await expect(client.graphql('{ me { bogus } }')).rejects.toThrow(/Internal service error/);
  });

  it('explains a non-JSON body rather than throwing a parse error', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>signed out</html>', { status: 200 }));
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/non-JSON/);
  });

  it('reports a network failure with its cause code', async () => {
    const err = Object.assign(new Error('fail'), { cause: { code: 'ENOTFOUND' } });
    const fetchImpl = vi.fn(async () => { throw err; });
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/ENOTFOUND/);
  });

  it('throws when the response carries neither data nor errors', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: null }));
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/no data/);
  });

  it('reports a non-2xx with no GraphQL error body as an HTTP failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: null }, 502));
    const client = new RemindClient({ fetchImpl: fetchImpl as never, captureSession: capture });
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
    const client = new RemindClient({ fetchImpl: fetchImpl as never, transportFactory });
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
    const client = new RemindClient({ fetchImpl: vi.fn() as never, transportFactory });
    await expect(client.graphql('{ me { uuid } }')).rejects.toThrow(/bridge down/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('prefers an env-supplied session and never touches the bridge', async () => {
    process.env.REMIND_COOKIE = 'env=1';
    process.env.REMIND_CSRF_TOKEN = 'envtok';
    const transportFactory = vi.fn();
    const fetchImpl = vi.fn(async () => jsonOk());
    try {
      const client = new RemindClient({ fetchImpl: fetchImpl as never, transportFactory: transportFactory as never });
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
