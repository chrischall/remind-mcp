import { describe, it, expect, vi } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { registerAccountTools } from '../src/tools/account.js';
import { registerChatTools } from '../src/tools/chats.js';
import { registerClassTools } from '../src/tools/classes.js';
import { registerRawTools } from '../src/tools/raw.js';
import type { RemindClient } from '../src/client.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off `tools/list` — what a host sees — for every tool this server serves.
 */
type Listed = {
  name: string;
  inputSchema: { properties?: Record<string, Record<string, unknown>> };
  annotations?: { readOnlyHint?: boolean };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

const register = (client: RemindClient) => (s: Parameters<typeof registerChatTools>[0]) => {
  registerAccountTools(s, client);
  registerClassTools(s, client);
  registerChatTools(s, client);
  registerRawTools(s, client);
};

async function served(): Promise<Listed[]> {
  const h = await createTestHarness(register({} as RemindClient));
  const { tools } = (await h.client.listTools()) as unknown as { tools: Listed[] };
  await h.close?.();
  return tools;
}

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  remind_me: 'lookup',
  remind_get_notification_settings: 'lookup',
  remind_set_notification_devices: 'turn-on-off',
  remind_list_entities: 'lookup',
  remind_get_classes: 'lookup',
  remind_list_chats: 'whats-new',
  remind_get_messages: 'lookup',
  remind_send_message: 'send',
  remind_graphql: 'other',
};

describe('_meta.mint on tools/list', () => {
  it('names every served tool except the healthcheck, so a new tool cannot skip the decision', async () => {
    const names = (await served()).map((t) => t.name).filter((n) => !n.endsWith('_healthcheck'));
    expect(names.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('leaves the healthcheck unhinted: it joins no group', async () => {
    const hc = (await served()).find((t) => t.name === 'remind_healthcheck');
    expect(hc).toBeDefined();
    expect(hc?._meta?.mint).toBeUndefined();
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain school and intent %s', async (name, intent) => {
    const mint = (await served()).find((t) => t.name === name)?._meta?.mint;
    expect(mint, name).toBeDefined();
    expect(mint!.domain).toBe('school');
    expect(mint!.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      if (t.name.endsWith('_healthcheck')) continue;
      const m = t._meta!.mint!;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(m.domain);
      expect(INTENTS, t.name).toContain(m.intent);
      if ('canonical' in m) {
        expect(m.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(m.intent);
      }
      if ('subject' in m) expect(props, t.name).toHaveProperty(m.subject as string);
      if ('when' in m) {
        const when = m.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in m) {
        const aliases = m.aliases as string[];
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('has at most one canonical read per what’s-new/due/on intent', async () => {
    const canonical = (await served()).filter((t) => t._meta?.mint?.canonical === true);
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter((t) => t._meta!.mint!.intent === intent).length, intent).toBeLessThanOrEqual(1);
    }
  });

  it('makes remind_list_chats the one canonical read: what’s new, no subject (none listable), no range', async () => {
    const canonical = (await served()).filter((t) => t._meta?.mint?.canonical === true);
    expect(canonical.map((t) => t.name)).toEqual(['remind_list_chats']);
    const mint = canonical[0]._meta!.mint!;
    expect(mint).toMatchObject({ domain: 'school', intent: 'whats-new', canonical: true });
    expect(mint).not.toHaveProperty('subject');
    expect(mint).not.toHaveProperty('when');
  });

  it('every canonical read accepts view: "brief"', async () => {
    for (const t of (await served()).filter((x) => x._meta?.mint?.canonical === true)) {
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
    }
  });
});

describe('remind_list_chats view: "brief"', () => {
  const BRIEF = /^.+ — (\d{4}-\d{2}-\d{2}T[^ ]+|no date) — .+$/;

  async function brief(chatStreams: unknown[]): Promise<string> {
    const graphql = vi.fn(async () => ({ chatStreams }));
    const h = await createTestHarness(register({ graphql } as unknown as RemindClient));
    const res = (await h.callTool('remind_list_chats', { view: 'brief' })) as { content: { text: string }[] };
    await h.close?.();
    return res.content[0].text;
  }

  it('answers one line per chat with unread messages: title — ISO date — N unread', async () => {
    const text = await brief([
      { uuid: 'c1', properTitle: 'Coach Smith', title: 'coach', unreadMessagesCount: 2, updatedAt: '2026-11-03T15:04:05Z' },
      { uuid: 'c2', title: 'Math 101', unreadMessagesCount: 0, updatedAt: '2026-11-01T10:00:00Z' },
      { uuid: 'c3', title: 'Band', unreadMessagesCount: 1, updatedAt: null },
    ]);
    expect(text.split('\n')).toEqual([
      'Coach Smith — 2026-11-03T15:04:05Z — 2 unread',
      'Band — no date — 1 unread',
    ]);
  });

  it('keeps every line within 120 characters and the brief shape, flattening newlines in a title', async () => {
    const text = await brief([
      { uuid: 'c1', title: `Very long\n${'x'.repeat(300)}`, unreadMessagesCount: 12, updatedAt: '2026-11-03T15:04:05Z' },
    ]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThanOrEqual(120);
    expect(lines[0]).toMatch(BRIEF);
    expect(lines[0]).toMatch(/— 2026-11-03T15:04:05Z — 12 unread$/);
  });

  it('answers nothing when no chat has unread messages, so a host counts zero items', async () => {
    expect(await brief([{ uuid: 'c1', title: 'Math', unreadMessagesCount: 0, updatedAt: '2026-11-01T00:00:00Z' }])).toBe('');
    expect(await brief([])).toBe('');
  });

  it('names an untitled chat and treats a missing count as nothing unread', async () => {
    const text = await brief([
      { uuid: 'c1', unreadMessagesCount: 3, updatedAt: '2026-11-03T00:00:00Z' },
      { uuid: 'c2', title: 'Quiet' },
    ]);
    expect(text).toBe('(untitled) — 2026-11-03T00:00:00Z — 3 unread');
  });

  it('still answers the full payload by default', async () => {
    const graphql = vi.fn(async () => ({ chatStreams: [{ uuid: 'c1', title: 'Coach' }] }));
    const h = await createTestHarness(register({ graphql } as unknown as RemindClient));
    const res = (await h.callTool('remind_list_chats', {})) as { content: { text: string }[] };
    expect(JSON.parse(res.content[0].text).chatStreams).toEqual([{ uuid: 'c1', title: 'Coach' }]);
  });
});
