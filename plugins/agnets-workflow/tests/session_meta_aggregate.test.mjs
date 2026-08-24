import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateSessionMetadata } from '../scripts/session_meta_aggregate.mjs';

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/session_meta_aggregate.mjs');

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('aggregates active and archive session_meta records with id de-duplication and exact counters', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'session-meta-fixture-'));
  try {
    const active = path.join(home, 'sessions', '2026', '08', '23');
    const archive = path.join(home, 'archived_sessions');
    await mkdir(active, { recursive: true }); await mkdir(archive, { recursive: true });
    const meta = (id, session_id, cwd, agent_role, parent_thread_id) => JSON.stringify({ type: 'session_meta', payload: { id, session_id, cwd, agent_role, parent_thread_id, timestamp: '2026-08-23T01:00:00Z' } });
    await writeFile(path.join(active, 'one.jsonl'), `${meta('thread-a', 'session-a', 'F:/one', 'avsp_luna_high', 'parent-a')}\n{"type":"event"}\n`);
    await writeFile(path.join(archive, 'archived-2026-08-23.jsonl'), `${meta('thread-a', 'session-a', 'F:/one', 'avsp_luna_high', 'parent-a')}\n`);
    await writeFile(path.join(archive, 'archived-2026-08-22.jsonl'), `${meta('thread-b', 'session-b', 'F:/two', 'avsp_terra_high', 'parent-b')}\n`);
    const result = await aggregateSessionMetadata({ codexHome: home, from: '2026-08-23', to: '2026-08-23' });
    assert.equal(result.active.total, 1); assert.equal(result.archive.total, 1);
    assert.equal(result.total, 1); assert.equal(result.counts.cwd['F:/one'], 1);
    assert.equal(result.records[0].parent_thread, 'parent-a');
    assert.equal(result.records.every(record => record.source === 'active' || record.source === 'archive'), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('rejects malformed JSON and non-session_meta first records', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'session-meta-errors-'));
  try {
    const active = path.join(home, 'sessions', '2026', '08', '23'); await mkdir(active, { recursive: true });
    await writeFile(path.join(active, 'bad.jsonl'), '{not-json}\n');
    await assert.rejects(() => aggregateSessionMetadata({ codexHome: home, from: '2026-08-23', to: '2026-08-23' }), /invalid JSON/);
    await writeFile(path.join(active, 'bad.jsonl'), '{"type":"event"}\n');
    await assert.rejects(() => aggregateSessionMetadata({ codexHome: home, from: '2026-08-23', to: '2026-08-23' }), /first record type must be session_meta/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('rejects invalid date ranges', async () => {
  await assert.rejects(() => aggregateSessionMetadata({ codexHome: path.resolve('fixture'), from: '2026-02-30', to: '2026-03-01' }), /valid calendar date/);
  await assert.rejects(() => aggregateSessionMetadata({ codexHome: path.resolve('fixture'), from: '2026-03-02', to: '2026-03-01' }), /on or before/);
});

test('CLI spawns Node entrypoint and returns filtered active/archive JSON', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'session-meta-cli-'));
  try {
    const active = path.join(home, 'sessions', '2026', '08', '23');
    const archive = path.join(home, 'archived_sessions');
    await mkdir(active, { recursive: true }); await mkdir(archive, { recursive: true });
    const meta = (id, cwd) => JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-08-23T01:00:00Z' } });
    await writeFile(path.join(active, 'active-match.jsonl'), `${meta('active-match', 'F:/workspace')}\n`);
    await writeFile(path.join(active, 'active-other.jsonl'), `${meta('active-other', 'F:/other')}\n`);
    await writeFile(path.join(archive, 'archive-match-2026-08-23.jsonl'), `${meta('archive-match', 'F:/workspace')}\n`);
    await writeFile(path.join(archive, 'archive-other-2026-08-23.jsonl'), `${meta('archive-other', 'F:/other')}\n`);
    const result = await runCli(['--codex-home', home, '--from', '2026-08-23', '--to', '2026-08-23', '--workspace', 'F:/workspace', '--format', 'json']);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.filters.workspace, 'F:/workspace');
    assert.equal(output.active.total, 1);
    assert.equal(output.archive.total, 1);
    assert.equal(output.total, 2);
    assert.deepEqual(new Set(output.records.map(record => record.source)), new Set(['active', 'archive']));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('CLI rejects invalid dates and missing required arguments with nonzero exit', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'session-meta-cli-errors-'));
  try {
    const invalidDate = await runCli(['--codex-home', home, '--from', '2026-02-30', '--to', '2026-03-01', '--format', 'json']);
    assert.notEqual(invalidDate.code, 0);
    assert.match(invalidDate.stderr, /valid calendar date/);
    const missingTo = await runCli(['--codex-home', home, '--from', '2026-03-01']);
    assert.notEqual(missingTo.code, 0);
    assert.match(missingTo.stderr, /usage requires --codex-home, --from and --to/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
