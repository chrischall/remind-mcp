import { describe, it, expect, afterEach } from 'vitest';
import { sessionFromCapture, sessionFromEnv, remindBootstrapOpts, DEFAULT_WS_PORT } from '../src/session.js';

const clearEnv = () => { delete process.env.REMIND_COOKIE; delete process.env.REMIND_CSRF_TOKEN; };
afterEach(clearEnv);

describe('sessionFromCapture', () => {
  it('builds a session from the two captured headers', () => {
    const s = sessionFromCapture({ capturedHeaders: { cookie: 'a=1', 'x-csrf-token': 'tok' } });
    expect(s.cookie).toBe('a=1');
    expect(s.csrfToken).toBe('tok');
    expect(Date.parse(s.capturedAt)).not.toBeNaN();
  });

  it.each([
    ['cookie', { 'x-csrf-token': 'tok' }],
    ['x-csrf-token', { cookie: 'a=1' }],
  ])('names the missing %s header in the error', (missing, headers) => {
    expect(() => sessionFromCapture({ capturedHeaders: headers })).toThrow(new RegExp(missing));
  });

  it('names both when nothing was captured', () => {
    expect(() => sessionFromCapture({})).toThrow(/cookie and x-csrf-token/);
  });
});

describe('sessionFromEnv', () => {
  it('is undefined unless BOTH variables are set', () => {
    clearEnv();
    expect(sessionFromEnv()).toBeUndefined();
    process.env.REMIND_COOKIE = 'a=1';
    expect(sessionFromEnv()).toBeUndefined();
    process.env.REMIND_CSRF_TOKEN = 'tok';
    expect(sessionFromEnv()).toMatchObject({ cookie: 'a=1', csrfToken: 'tok' });
  });
});

describe('remindBootstrapOpts', () => {
  it('declares capture of exactly the two auth headers on the graphql path', async () => {
    const opts = await remindBootstrapOpts();
    const captured = (opts.captureHeaders ?? []).map((c) => `${c.headerName}@${c.host}${c.path ?? ''}`);
    expect(captured.sort()).toEqual([
      'cookie@www.remind.com/graphql*',
      'x-csrf-token@www.remind.com/graphql*',
    ]);
  });

  it('declares no cookie/storage scopes — header capture is the only route', async () => {
    // The named cookie read returns empty on remind.com (see docs/REMIND-API.md),
    // so widening scope here would ask users to approve capabilities we never use.
    const opts = await remindBootstrapOpts();
    expect(opts.cookieKeys ?? []).toEqual([]);
    expect(opts.localStorageKeys ?? []).toEqual([]);
  });

  it('pins the shared fleet concentrator port', () => {
    // The Transporter extension dials ONE port for the whole fleet.
    expect(DEFAULT_WS_PORT).toBe(37_149);
  });
});

describe('captureRemindHeaders', () => {
  it('arms both captures CONCURRENTLY, not in series', async () => {
    const { captureRemindHeaders } = await import('../src/session.js');
    let live = 0;
    let maxLive = 0;
    const server = {
      captureRequestHeader: async ({ headerName }: { headerName: string }) => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        await new Promise((r) => setTimeout(r, 10));
        live -= 1;
        return headerName === 'cookie' ? 'a=1' : 'tok';
      },
    };
    const s = await captureRemindHeaders(server);
    // Both headers ride the same request; serial arming would miss the second.
    expect(maxLive).toBe(2);
    expect(s).toMatchObject({ cookie: 'a=1', csrfToken: 'tok' });
  });

  it('requests both headers on the graphql path of the www host', async () => {
    const { captureRemindHeaders } = await import('../src/session.js');
    const calls: unknown[] = [];
    await captureRemindHeaders({
      captureRequestHeader: async (o) => { calls.push(o); return 'v'; },
    });
    expect(calls).toEqual([
      { host: 'www.remind.com', path: '/graphql*', headerName: 'cookie' },
      { host: 'www.remind.com', path: '/graphql*', headerName: 'x-csrf-token' },
    ]);
  });

  it('propagates the missing-header error when a capture comes back empty', async () => {
    const { captureRemindHeaders } = await import('../src/session.js');
    await expect(
      captureRemindHeaders({
        captureRequestHeader: async ({ headerName }) => (headerName === 'cookie' ? 'a=1' : ''),
      }),
    ).rejects.toThrow(/x-csrf-token/);
  });
});

describe('createRemindTransport', () => {
  it('constructs a bridge transport on the shared port without connecting', async () => {
    // The bridge binds lazily — the port is claimed on the first verb call, not
    // at construction — so building one here connects to nothing.
    const { createRemindTransport } = await import('../src/session.js');
    const transport = await createRemindTransport();
    try {
      expect(transport.role).toBeNull();
      expect(typeof transport.server.captureRequestHeader).toBe('function');
    } finally {
      await transport.close().catch(() => {});
    }
  });

  it('honours REMIND_WS_PORT over the default', async () => {
    process.env.REMIND_WS_PORT = '40000';
    const { createRemindTransport } = await import('../src/session.js');
    const transport = await createRemindTransport();
    try {
      expect(transport.server).toBeDefined();
    } finally {
      await transport.close().catch(() => {});
      delete process.env.REMIND_WS_PORT;
    }
  });
});
