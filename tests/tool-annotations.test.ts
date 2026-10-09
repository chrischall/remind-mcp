import { describe, it, expect } from 'vitest';
import { registerAccountTools } from '../src/tools/account.js';
import { registerChatTools } from '../src/tools/chats.js';
import { registerClassTools } from '../src/tools/classes.js';
import { registerRawTools } from '../src/tools/raw.js';

/**
 * Fleet annotation meta-test (modelled on skylight-mcp
 * tests/tool-annotations.test.ts). It reads the REGISTERED config rather than
 * a hand-kept list, so a newly added tool cannot skip the rules.
 *
 * `destructiveHint` DEFAULTS TO TRUE whenever readOnlyHint is false, so a write
 * that forgets to declare it and a write that considered it leave identical
 * annotations — the invariant worth pinning is that each write CHOOSES.
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

function registeredAnnotations(): Record<string, Ann | undefined> {
  const seen: Record<string, Ann | undefined> = {};
  const server = {
    registerTool: (name: string, cfg: { annotations?: Ann }) => {
      seen[name] = cfg.annotations;
    },
  } as never;
  // Registration never touches the client; only the handlers do.
  const client = {} as never;
  for (const register of [registerAccountTools, registerClassTools, registerChatTools, registerRawTools]) {
    register(server, client);
  }
  return seen;
}

describe('every tool declares truthful annotations', () => {
  it('registers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(registeredAnnotations())).toHaveLength(10);
  });

  it('sets an explicit boolean readOnlyHint on all of them', () => {
    const missing = Object.entries(registeredAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('marks every tool open-world (each one talks to remind.com)', () => {
    const notOpen = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.openWorldHint !== true)
      .map(([name]) => name);
    expect(notOpen).toEqual([]);
  });

  it('holds the destructive set at its measured size', () => {
    // Counted off the built server: only remind_send_message, which reaches
    // real people and cannot be unsent.
    const destructive = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(destructive).toEqual(['remind_send_message']);
  });
});
