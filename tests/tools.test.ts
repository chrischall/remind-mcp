import { describe, it, expect, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerAccountTools } from '../src/tools/account.js';
import { registerChatTools } from '../src/tools/chats.js';
import { registerClassTools } from '../src/tools/classes.js';
import { registerRawTools } from '../src/tools/raw.js';
import type { RemindClient } from '../src/client.js';

const stubClient = (graphql: ReturnType<typeof vi.fn>) => ({ graphql }) as unknown as RemindClient;

describe('read tools', () => {
  it('remind_me returns the account payload', async () => {
    const graphql = vi.fn(async () => ({ me: { uuid: 'u1', first_name: 'Chris' } }));
    const h = await createTestHarness((s) => registerAccountTools(s, stubClient(graphql)));
    const out = parseToolResult(await h.callTool('remind_me', {}));
    expect(out).toEqual({ me: { uuid: 'u1', first_name: 'Chris' } });
  });

  it('remind_list_entities passes nulls, not undefined, for absent filters', async () => {
    const graphql = vi.fn(async () => ({ navigationList: { items: [], cursor: null } }));
    const h = await createTestHarness((s) => registerClassTools(s, stubClient(graphql)));
    await h.callTool('remind_list_entities', {});
    expect(graphql.mock.calls[0][1]).toEqual({ query: null, lastCursor: null });
  });

  it('remind_get_messages forwards the limit', async () => {
    const graphql = vi.fn(async () => ({ chatStreams: [] }));
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
    await h.callTool('remind_get_messages', { uuids: ['c1'], limit: 5 });
    expect(graphql.mock.calls[0][1]).toEqual({ chatUuids: ['c1'], limit: 5 });
  });
});

describe('confirm-gated writes', () => {
  it('remind_send_message makes NO network call without confirm', async () => {
    const graphql = vi.fn();
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
    const out = parseToolResult<{ dryRun: boolean; wouldSend: unknown }>(
      await h.callTool('remind_send_message', { recipient_uuid: 'c1', body: 'hi' }),
    );
    expect(graphql).not.toHaveBeenCalled();
    expect(out.dryRun).toBe(true);
    expect(out.wouldSend).toEqual({
      mutation: 'putMessage',
      input: { recipients: [{ type: 'chat', uuid: 'c1' }], message: { body: 'hi', urgent: false } },
    });
  });

  it('remind_send_message sends only with confirm:true', async () => {
    const graphql = vi.fn(async () => ({ putMessage: { error: null } }));
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
    await h.callTool('remind_send_message', { recipient_uuid: 'c1', body: 'hi', confirm: true });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('remind_set_notification_devices previews without calling', async () => {
    const graphql = vi.fn();
    const h = await createTestHarness((s) => registerAccountTools(s, stubClient(graphql)));
    const out = parseToolResult<{ dryRun: boolean }>(
      await h.callTool('remind_set_notification_devices', { disable: [7] }),
    );
    expect(graphql).not.toHaveBeenCalled();
    expect(out.dryRun).toBe(true);
  });

  it('remind_set_notification_devices re-reads and reports observed state', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        accountNotificationsScreen: { devices: [{ id: 7, isEnabled: false }, { id: 8, isEnabled: true }] },
      });
    const h = await createTestHarness((s) => registerAccountTools(s, stubClient(graphql)));
    const out = parseToolResult<{ verifiedState: unknown }>(
      await h.callTool('remind_set_notification_devices', { disable: [7], confirm: true }),
    );
    // Only the touched device is reported, and the value is the RE-READ one.
    expect(out.verifiedState).toEqual([{ id: 7, isEnabled: false }]);
  });

  it('remind_set_notification_devices refuses an empty change set', async () => {
    const graphql = vi.fn();
    const h = await createTestHarness((s) => registerAccountTools(s, stubClient(graphql)));
    const res = await h.callTool('remind_set_notification_devices', { confirm: true });
    expect(res.isError).toBe(true);
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe('remind_graphql escape hatch', () => {
  it('runs a read query', async () => {
    const graphql = vi.fn(async () => ({ __schema: { queryType: { name: 'Query' } } }));
    const h = await createTestHarness((s) => registerRawTools(s, stubClient(graphql)));
    await h.callTool('remind_graphql', { query: '{ __schema { queryType { name } } }' });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['mutation M { putMessage { __typename } }'],
    ['  mutation { x }'],
    ['query A { a } mutation B { b }'],
  ])('refuses a mutation document: %s', async (doc) => {
    const graphql = vi.fn();
    const h = await createTestHarness((s) => registerRawTools(s, stubClient(graphql)));
    const res = await h.callTool('remind_graphql', { query: doc });
    expect(res.isError).toBe(true);
    expect(graphql).not.toHaveBeenCalled();
  });

  it('does not mistake a field named mutationCount for a mutation', async () => {
    const graphql = vi.fn(async () => ({ ok: true }));
    const h = await createTestHarness((s) => registerRawTools(s, stubClient(graphql)));
    const res = await h.callTool('remind_graphql', { query: '{ stats { mutationCount } }' });
    expect(res.isError).toBeFalsy();
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('remind_healthcheck reports ok for an authenticated account', async () => {
    const graphql = vi.fn(async () => ({ me: { uuid: 'u1' } }));
    const h = await createTestHarness((s) => registerRawTools(s, stubClient(graphql)));
    const out = parseToolResult<{ ok: boolean }>(await h.callTool('remind_healthcheck', {}));
    expect(out.ok).toBe(true);
  });
});
