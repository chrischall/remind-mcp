import { describe, it, expect, vi } from 'vitest';

/**
 * The captures in `session.ts` pass no per-call `timeoutMs`, so they run for
 * the EXTENSION's own 30 s default — which tied exactly with the transport's
 * 30 s deadline. The transport's timer starts first, since its frame has yet
 * to travel, so it won that tie essentially always and the extension's
 * rejection was lost.
 *
 * That rejection is the one that explains itself ("a capture resolves on the
 * next matching request the PAGE makes, so an idle tab times out"). What
 * arrived instead was a bare `did not respond within 30000ms` — a number this
 * repo never chose, about a mechanism it never named.
 *
 * Its own file because the assertion needs the module mocked, and mocking it
 * for `session.test.ts` would replace the real bootstrap every other test
 * there depends on.
 */
vi.mock('@chrischall/mcp-utils/fetchproxy', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createFetchproxyTransport: vi.fn((o: Record<string, unknown>) => {
      seen.push(o);
      return { server: {}, start: async () => {}, close: async () => {} };
    }),
  };
});

const seen: Record<string, unknown>[] = [];

describe('the capture window is declared to the transport', () => {
  it('declares the window the captures actually rely on', async () => {
    const { createRemindTransport } = await import('../src/session.js');
    await createRemindTransport();
    // 30 s is the extension's own default, inherited by passing nothing.
    // Declaring it is what lets the transport raise its deadline clear of it.
    expect(seen[0]!.captureWindowMs).toBe(30_000);
  });
});
