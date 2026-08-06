import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const mcpScript = fileURLToPath(new URL('../scripts/workflow_controller_mcp.mjs', import.meta.url));
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));

function startMcp() {
  const child = spawn(process.execPath, [mcpScript], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffered = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line); const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  let nextId = 1;
  return {
    child,
    request(value) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...value })}\n`, error => {
          if (error) { pending.delete(id); reject(error); }
        });
      });
    },
  };
}

test('plugin manifest and MCP cache target use the same cachebuster version', async () => {
  const plugin = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const launcher = mcp.mcpServers['workflow-controller'].args[1];
  assert.match(launcher, new RegExp(`const version=['\"]${plugin.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"]`));
  assert.doesNotMatch(launcher, /candidates\.length/);
});

test('MCP server creates and reads a SQLite-backed workflow task over stdio', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-'));
  const workspace = path.join(root, 'workspace'); const stateDir = path.join(root, 'state'); const manifest = path.join(root, 'manifest.json');
  const server = startMcp();
  try {
    await mkdir(workspace); await writeFile(path.join(workspace, 'app.txt'), 'test\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'mcp-task', workspace, goal: 'verify MCP persistence', requirements: [{ id: 'R1', text: 'store state' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high' }] }));
    const initialized = await server.request({ method: 'initialize', params: {} });
    assert.equal(initialized.result.serverInfo.name, 'agnets-workflow');
    const init = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest, state_dir: stateDir } } });
    assert.equal(JSON.parse(init.result.content[0].text).task.task_id, 'mcp-task');
    const ensured = await server.request({ method: 'tools/call', params: { name: 'workflow_ensure_context', arguments: { workspace, task_id: 'mcp-task', state_dir: stateDir } } });
    assert.equal(JSON.parse(ensured.result.content[0].text).state, 'active');
    const status = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    assert.equal(JSON.parse(status.result.content[0].text).task_id, 'mcp-task');
    const doctor = await server.request({ method: 'tools/call', params: { name: 'workflow_doctor', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    const diagnosis = JSON.parse(doctor.result.content[0].text);
    assert.equal(diagnosis.health, 'healthy');
    assert.equal(diagnosis.checks.find(check => check.id === 'state_database').status, 'pass');
    const directoryDoctor = await server.request({ method: 'tools/call', params: { name: 'workflow_doctor', arguments: { state_dir: stateDir } } });
    const directoryDiagnosis = JSON.parse(directoryDoctor.result.content[0].text);
    assert.equal(directoryDiagnosis.health, 'healthy');
    assert.deepEqual(directoryDiagnosis.checks.find(check => check.id === 'orphan_legacy').detail.paths, []);
    assert.equal((await readFile(path.join(stateDir, 'mcp-task.sqlite'))).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  } finally {
    server.child.stdin.end();
    await new Promise(resolve => server.child.once('exit', resolve));
    await rm(root, { recursive: true, force: true });
  }
});
