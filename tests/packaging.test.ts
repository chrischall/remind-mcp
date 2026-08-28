import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8'));
const pkg = read('package.json');

describe('package.json', () => {
  it('declares the repository url npm --provenance validates against', () => {
    expect(pkg.repository?.url).toBe('git+https://github.com/chrischall/remind-mcp.git');
  });
  it('publishes the scoped name publicly', () => {
    expect(pkg.name).toBe('@chrischall/remind-mcp');
    expect(pkg.publishConfig?.access).toBe('public');
  });
  it('ships skills and mint.yaml in the tarball', () => {
    // An npm-sourced mcp-host registration reads the TARBALL: a mint.yaml
    // missing from `files` yields a silently blank register wizard.
    for (const f of ['dist', 'skills', 'mint.yaml', 'server.json', '.claude-plugin']) {
      expect(pkg.files).toContain(f);
    }
  });
});

describe('version consistency across manifests', () => {
  it('all manifests carry package.json version', () => {
    expect(read('manifest.json').version).toBe(pkg.version);
    expect(read('server.json').version).toBe(pkg.version);
    expect(read('.claude-plugin/plugin.json').version).toBe(pkg.version);
    expect(read('.claude-plugin/marketplace.json').metadata.version).toBe(pkg.version);
    for (const p of read('server.json').packages) expect(p.version).toBe(pkg.version);
    for (const p of read('.claude-plugin/marketplace.json').plugins) expect(p.version).toBe(pkg.version);
  });
  it('server.json description fits the MCP registry limit', () => {
    expect(read('server.json').description.length).toBeLessThanOrEqual(100);
  });
});
