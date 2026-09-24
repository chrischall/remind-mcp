import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

/** One entry of the `tools/list` result, with the schema the server GENERATED. */
type ListedTool = {
  name: string;
  description?: string;
  inputSchema: { type?: string; properties?: Record<string, JsonSchema>; required?: string[] };
};
type JsonSchema = Record<string, unknown>;

/**
 * Drive a real `initialize` + `tools/list` handshake against a spawned server.
 *
 * The WHOLE tool entry comes back, `inputSchema` included: the schema is not
 * written by hand anywhere in this repo, it is generated from each tool's
 * `z.object({ … })` by the SDK, so the wire is the only place to read it.
 */
function handshake(entry: string, cwd: string): Promise<{ tools: ListedTool[]; stderr: string }> {
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
            resolve({ tools: j.result.tools as ListedTool[], stderr: err });
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
  let binTools: ListedTool[] = [];
  const nameOf = (tools: ListedTool[]) => tools.map((t) => t.name);
  const byName = (tools: ListedTool[], name: string) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`${name} is not registered; listed: ${nameOf(tools).join(', ')}`);
    return tool;
  };

  beforeAll(async () => {
    binTools = (await handshake(join(repo, 'dist/index.js'), repo)).tools;
  }, 30_000);

  it('the bin entrypoint boots and lists tools', () => {
    // A wrong tsconfig rootDir emits dist/src/index.js and this fails.
    expect(binTools.length).toBeGreaterThanOrEqual(10);
  });

  it('every tool advertises a generated object schema', () => {
    // The declarations say `inputSchema: z.object({ … })` and the SDK turns each
    // one into JSON Schema on the way out. A tool whose schema is missing, or is
    // not an object schema, is one no client can call correctly — and nothing in
    // the source would look wrong, because the source never spells the schema.
    for (const t of binTools) {
      expect(t.inputSchema, t.name).toBeTruthy();
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(typeof t.inputSchema.properties, t.name).toBe('object');
    }
  });

  it('a no-argument tool still generates an empty object schema', () => {
    // `z.object({})` must render as a schema with no properties, NOT as an
    // absent one: a client that sees no schema at all has no reason to believe
    // the tool takes nothing.
    const schema = byName(binTools, 'remind_me').inputSchema;
    expect(schema.properties).toEqual({});
    expect(schema.required ?? []).toEqual([]);
  });

  it('the generated schema carries the shape of each argument', () => {
    // remind_send_message is the widest declaration in the repo — required and
    // optional fields, an enum, two defaults, a length floor and a description
    // per field — so it is where a wrapper that quietly dropped or flattened
    // part of a shape would show up first.
    const schema = byName(binTools, 'remind_send_message').inputSchema;
    const props = schema.properties ?? {};
    expect(Object.keys(props).sort()).toEqual(
      ['body', 'confirmToken', 'recipient_type', 'recipient_uuid', 'urgent'],
    );
    // Only the two fields with neither a default nor `.optional()` are required.
    expect([...(schema.required ?? [])].sort()).toEqual(['body', 'recipient_uuid']);
    expect(props.recipient_type).toMatchObject({ type: 'string', enum: ['chat', 'group'], default: 'chat' });
    expect(props.urgent).toMatchObject({ type: 'boolean', default: false });
    expect(props.body).toMatchObject({ type: 'string', minLength: 1 });
    expect(props.confirmToken).toMatchObject({ type: 'string' });
    for (const [field, spec] of Object.entries(props)) {
      expect(typeof spec.description, `${field} description`).toBe('string');
    }
  });

  it('the bundle boots with NO node_modules — the .mcpb runtime', async () => {
    // Catches an eager import of an esbuild --external dep, which crashes the
    // bundled server at LOAD, before it can answer initialize.
    const dir = mkdtempSync(join(tmpdir(), 'remind-mcpb-'));
    copyFileSync(join(repo, 'dist/bundle.js'), join(dir, 'bundle.js'));
    const { tools } = await handshake(join(dir, 'bundle.js'), dir);
    expect(tools.length).toBeGreaterThanOrEqual(10);
    // The schemas are generated by whichever zod the BUNDLE ended up with, so
    // they are the place a bundling change (an alias, a dedupe, a version skew)
    // would alter the wire without altering a line of source.
    expect(nameOf(tools).sort()).toEqual(nameOf(binTools).sort());
    for (const t of tools) {
      expect(t.inputSchema, t.name).toEqual(byName(binTools, t.name).inputSchema);
    }
  }, 30_000);

  it('manifest.json lists exactly the tools the server registers', () => {
    const manifest = JSON.parse(readFileSync(join(repo, 'manifest.json'), 'utf8'));
    const declared: string[] = manifest.tools.map((t: { name: string }) => t.name);
    // Both directions: an undeclared tool is invisible to an mcpb host, and a
    // declared-but-absent one is a broken promise.
    expect([...declared].sort()).toEqual(nameOf(binTools).sort());
    for (const t of manifest.tools) expect(t.description?.trim()).toBeTruthy();
  });
});
