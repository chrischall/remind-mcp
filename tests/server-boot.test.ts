import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

/** Drive a real `initialize` + `tools/list` handshake against a spawned server. */
function handshake(entry: string, cwd: string): Promise<{ tools: string[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [entry], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout; stderr=${err}`)); }, 25_000);
    p.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.id === 2) {
            clearTimeout(timer);
            p.kill();
            resolve({ tools: j.result.tools.map((t: { name: string }) => t.name), stderr: err });
          }
        } catch { /* partial line */ }
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n',
    );
  });
}

const built = existsSync(join(repo, 'dist/index.js')) && existsSync(join(repo, 'dist/bundle.js'));

describe.runIf(built)('server boot (real artifacts)', () => {
  let binTools: string[] = [];

  beforeAll(async () => {
    binTools = (await handshake(join(repo, 'dist/index.js'), repo)).tools;
  }, 30_000);

  it('the bin entrypoint boots and lists tools', () => {
    // A wrong tsconfig rootDir emits dist/src/index.js and this fails.
    expect(binTools.length).toBeGreaterThanOrEqual(10);
  });

  it('the bundle boots with NO node_modules — the .mcpb runtime', async () => {
    // Catches an eager import of an esbuild --external dep, which crashes the
    // bundled server at LOAD, before it can answer initialize.
    const dir = mkdtempSync(join(tmpdir(), 'remind-mcpb-'));
    copyFileSync(join(repo, 'dist/bundle.js'), join(dir, 'bundle.js'));
    const { tools } = await handshake(join(dir, 'bundle.js'), dir);
    expect(tools.length).toBeGreaterThanOrEqual(10);
  }, 30_000);

  it('manifest.json lists exactly the tools the server registers', () => {
    const manifest = JSON.parse(readFileSync(join(repo, 'manifest.json'), 'utf8'));
    const declared: string[] = manifest.tools.map((t: { name: string }) => t.name);
    // Both directions: an undeclared tool is invisible to an mcpb host, and a
    // declared-but-absent one is a broken promise.
    expect([...declared].sort()).toEqual([...binTools].sort());
    for (const t of manifest.tools) expect(t.description?.trim()).toBeTruthy();
  });
});
