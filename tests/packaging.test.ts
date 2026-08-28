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

describe('manifest.json is packable by mcpb', () => {
  // The mcpb manifest schema sets `additionalProperties: false`, so ONE stray
  // top-level key makes `mcpb pack` fail outright. That failure is close to
  // invisible in CI — the publish step still reports success and still prints
  // "Built <name>.mcpb" — so remind-mcp and angi-mcp both shipped releases with
  // no .mcpb attached. Keys are from mcpb 2.1.2's own
  // dist/mcpb-manifest-v0.2.schema.json, not hand-written.
  const ALLOWED = new Set([
    '$schema', 'dxt_version', 'manifest_version', 'name', 'display_name', 'version',
    'description', 'long_description', 'author', 'repository', 'homepage', 'documentation',
    'support', 'icon', 'screenshots', 'server', 'tools', 'tools_generated', 'prompts',
    'prompts_generated', 'keywords', 'license', 'privacy_policies', 'compatibility', 'user_config',
  ]);
  const manifest = read('manifest.json') as Record<string, unknown>;

  it('has no top-level key the schema would reject', () => {
    expect(Object.keys(manifest).filter((k) => !ALLOWED.has(k))).toEqual([]);
  });

  it('declares its node floor under compatibility, not at the top level', () => {
    // `runtimes` at the top level is the exact key that broke this repo.
    expect(manifest).not.toHaveProperty('runtimes');
    const compat = manifest.compatibility as { runtimes?: { node?: string } } | undefined;
    expect(compat?.runtimes?.node).toMatch(/^>=/);
  });

  it('keeps the node floor on an LTS so LTS users can install', () => {
    const node = (manifest.compatibility as { runtimes: { node: string } }).runtimes.node;
    const major = Number(node.replace(/^\D*/, '').split('.')[0]);
    expect(major).toBeLessThanOrEqual(22);
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
