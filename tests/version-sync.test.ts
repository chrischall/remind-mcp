import { describe, it, expect } from 'vitest';
import { versionSyncTest } from '@chrischall/mcp-utils/test';
import { fileURLToPath } from 'node:url';

describe('version sync', () => {
  it('every x-release-please-version marker matches package.json', () => {
    expect(
      versionSyncTest({
        srcDir: fileURLToPath(new URL('../src', import.meta.url)),
        pkgPath: fileURLToPath(new URL('../package.json', import.meta.url)),
      }),
    ).toEqual([]);
  });
});
