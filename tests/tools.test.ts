import { afterEach, describe, it, expect, vi } from 'vitest';
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

  it('remind_get_classes forwards the uuids', async () => {
    const graphql = vi.fn(async () => ({ classes: [{ uuid: 'g1' }] }));
    const h = await createTestHarness((s) => registerClassTools(s, stubClient(graphql)));
    const out = parseToolResult(await h.callTool('remind_get_classes', { uuids: ['g1'] }));
    expect(graphql.mock.calls[0][1]).toEqual({ uuids: ['g1'] });
    expect(out).toEqual({ classes: [{ uuid: 'g1' }] });
  });

  it('remind_list_entities passes a supplied query and cursor through', async () => {
    const graphql = vi.fn(async () => ({ navigationList: { items: [], cursor: 'c2' } }));
    const h = await createTestHarness((s) => registerClassTools(s, stubClient(graphql)));
    await h.callTool('remind_list_entities', { query: 'math', cursor: 'c1' });
    expect(graphql.mock.calls[0][1]).toEqual({ query: 'math', lastCursor: 'c1' });
  });

  it('remind_list_chats coerces every absent filter to null', async () => {
    const graphql = vi.fn(async () => ({ chatStreams: [] }));
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
    await h.callTool('remind_list_chats', {});
    expect(graphql.mock.calls[0][1]).toEqual({ chatUuids: null, groupId: null, chatQuery: null });
  });

  it('remind_list_chats forwards every filter when supplied', async () => {
    const graphql = vi.fn(async () => ({ chatStreams: [] }));
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
    await h.callTool('remind_list_chats', { uuids: ['c1'], class_id: 7, query: 'coach' });
    expect(graphql.mock.calls[0][1]).toEqual({ chatUuids: ['c1'], groupId: 7, chatQuery: 'coach' });
  });

  it('remind_get_notification_settings returns the screen payload', async () => {
    const graphql = vi.fn(async () => ({ accountNotificationsScreen: { devices: [] } }));
    const h = await createTestHarness((s) => registerAccountTools(s, stubClient(graphql)));
    const out = parseToolResult(await h.callTool('remind_get_notification_settings', {}));
    expect(out).toEqual({ accountNotificationsScreen: { devices: [] } });
  });

  it('remind_get_messages forwards the limit', async () => {
    const graphql = vi.fn(async () => ({ chatStreams: [] }));
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
    await h.callTool('remind_get_messages', { uuids: ['c1'], limit: 5 });
    expect(graphql.mock.calls[0][1]).toEqual({ chatUuids: ['c1'], limit: 5 });
  });
});

const accept = { elicitation: async () => ({ action: 'accept' as const, content: { confirmed: true } }) };
const decline = { elicitation: async () => ({ action: 'decline' as const }) };

interface Phase1 {
  status: string;
  confirmToken: string;
  preview: Record<string, unknown>;
}

const SEND_ARGS = { recipient_uuid: 'c1', body: 'hi' };
const SENT = { putMessage: { error: null, messages: [{ __typename: 'MessageItem' }] } };

/** Phase 1 then phase 2 through a harness that cannot be prompted (the token flow). */
async function sendViaToken(
  graphql: ReturnType<typeof vi.fn>,
  args: Record<string, unknown> = SEND_ARGS,
) {
  const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
  const phase1 = parseToolResult<Phase1>(await h.callTool('remind_send_message', args));
  return h.callTool('remind_send_message', { ...args, confirmToken: phase1.confirmToken });
}

describe('confirmed writes', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('remind_send_message phase 1 returns a preview and token and makes NO network call', async () => {
    const graphql = vi.fn();
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
    const out = parseToolResult<Phase1>(await h.callTool('remind_send_message', SEND_ARGS));
    expect(graphql).not.toHaveBeenCalled();
    expect(out.status).toBe('confirmation-required');
    expect(typeof out.confirmToken).toBe('string');
    expect(out.preview.wouldSend).toEqual({
      mutation: 'putMessage',
      input: { recipients: [{ type: 'chat', uuid: 'c1' }], message: { body: 'hi', urgent: false } },
    });
    expect(out.preview.warning).toMatch(/cannot be unsent/);
  });

  it('remind_send_message phase 2 with the token sends exactly once', async () => {
    const graphql = vi.fn(async () => SENT);
    const res = await sendViaToken(graphql);
    expect(res.isError).toBeFalsy();
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0][1]).toEqual({
      input: { recipients: [{ type: 'chat', uuid: 'c1' }], message: { body: 'hi', urgent: false } },
    });
  });

  it('remind_send_message refuses a replayed token with TOKEN_REUSED and does not resend', async () => {
    const graphql = vi.fn(async () => SENT);
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
    const { confirmToken } = parseToolResult<Phase1>(await h.callTool('remind_send_message', SEND_ARGS));
    await h.callTool('remind_send_message', { ...SEND_ARGS, confirmToken });
    const replay = await h.callTool('remind_send_message', { ...SEND_ARGS, confirmToken });
    expect(JSON.stringify(replay.content)).toMatch(/TOKEN_REUSED/);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('remind_send_message refuses a token when the body changed (DRAFT_CHANGED) and does not send', async () => {
    const graphql = vi.fn(async () => SENT);
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
    const { confirmToken } = parseToolResult<Phase1>(await h.callTool('remind_send_message', SEND_ARGS));
    const res = await h.callTool('remind_send_message', { ...SEND_ARGS, body: 'something else', confirmToken });
    expect(JSON.stringify(res.content)).toMatch(/DRAFT_CHANGED/);
    expect(graphql).not.toHaveBeenCalled();
  });

  it('remind_send_message sends when a promptable client accepts', async () => {
    const graphql = vi.fn(async () => SENT);
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)), accept);
    const res = await h.callTool('remind_send_message', SEND_ARGS);
    expect(res.isError).toBeFalsy();
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('remind_send_message does not send when a promptable client declines', async () => {
    const graphql = vi.fn(async () => SENT);
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)), decline);
    await h.callTool('remind_send_message', SEND_ARGS);
    expect(graphql).not.toHaveBeenCalled();
  });

  it('remind_send_message is refused under MCP_CONFIRM_MODE=refuse', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    const graphql = vi.fn(async () => SENT);
    const h = await createTestHarness((s) => registerChatTools(s, stubClient(graphql)));
    const out = parseToolResult<{ reason: string }>(await h.callTool('remind_send_message', SEND_ARGS));
    expect(out.reason).toBe('confirmation-unsupported');
    expect(graphql).not.toHaveBeenCalled();
  });

  it.each([
    ['a populated error', { putMessage: { error: { __typename: 'CannotSendError' }, messages: null } }, /CannotSendError/],
    ['no messages', { putMessage: { error: null, messages: [] } }, /no message/i],
    ['a null payload', { putMessage: null }, /no message/i],
  ])('remind_send_message reports a failed send (%s) as an error', async (_label, payload, pattern) => {
    const graphql = vi.fn(async () => payload);
    const res = await sendViaToken(graphql);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(pattern);
  });

  it('remind_send_message reports success with the sent messages', async () => {
    const graphql = vi.fn(async () => SENT);
    const res = await sendViaToken(graphql);
    expect(res.isError).toBeFalsy();
    expect(parseToolResult<{ sent: boolean; messages: unknown[] }>(res)).toEqual({
      sent: true,
      messages: [{ __typename: 'MessageItem' }],
    });
  });

  it('remind_set_notification_devices phase 1 previews without calling', async () => {
    const graphql = vi.fn();
    const h = await createTestHarness((s) => registerAccountTools(s, stubClient(graphql)));
    const out = parseToolResult<Phase1>(
      await h.callTool('remind_set_notification_devices', { enable: [3], disable: [7] }),
    );
    expect(graphql).not.toHaveBeenCalled();
    expect(out.status).toBe('confirmation-required');
    expect(out.preview.wouldSend).toEqual({
      mutation: 'updateAccountNotificationsScreen',
      input: { devicesToEnable: [3], devicesToDisable: [7] },
    });
  });

  it('remind_set_notification_devices phase 2 applies once, re-reads and reports observed state', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        accountNotificationsScreen: { devices: [{ id: 7, isEnabled: false }, { id: 8, isEnabled: true }] },
      });
    const h = await createTestHarness((s) => registerAccountTools(s, stubClient(graphql)));
    const { confirmToken } = parseToolResult<Phase1>(
      await h.callTool('remind_set_notification_devices', { disable: [7] }),
    );
    expect(graphql).not.toHaveBeenCalled();
    const out = parseToolResult<{ verifiedState: unknown }>(
      await h.callTool('remind_set_notification_devices', { disable: [7], confirmToken }),
    );
    // Exactly one mutation, then the verifying re-read.
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[0][1]).toEqual({ input: { devicesToDisable: [7] } });
    // Only the touched device is reported, and the value is the RE-READ one.
    expect(out.verifiedState).toEqual([{ id: 7, isEnabled: false }]);
  });

  it('remind_set_notification_devices refuses an empty change set', async () => {
    const graphql = vi.fn();
    const h = await createTestHarness((s) => registerAccountTools(s, stubClient(graphql)), accept);
    const res = await h.callTool('remind_set_notification_devices', {});
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
    // GraphQL commas are insignificant, and an operation may directly follow `}`.
    [',mutation M($i:PutMessageInput!){putMessage(input:$i){error{__typename}}}'],
    ['query A{me{id}}mutation B{x}'],
    ['# harmless\nmutation{x}'],
    ['\uFEFFmutation{x}'],
    ['subscription S { x }'],
    ['not a graphql document {'],
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

  it('does not mistake the word mutation inside a string argument for a mutation', async () => {
    const graphql = vi.fn(async () => ({ ok: true }));
    const h = await createTestHarness((s) => registerRawTools(s, stubClient(graphql)));
    const res = await h.callTool('remind_graphql', {
      query: 'query Q { search(q: "} mutation {") { id } } fragment F on Class { uuid }',
    });
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
