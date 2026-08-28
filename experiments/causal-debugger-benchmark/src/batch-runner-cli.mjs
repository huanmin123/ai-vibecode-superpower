#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCodexTask, validateRunnerTask } from './codex-runner.mjs';

function usage() {
  return 'Usage: node src/batch-runner-cli.mjs --task-dir <dir> --result-dir <dir> --transcript-dir <dir> --diagnostics-dir <dir> [--concurrency <n>] [--codex <codex.cmd>] [--force]';
}

function parseArguments(argv) {
  const options = {};
  const allowed = new Set(['task-dir', 'result-dir', 'transcript-dir', 'diagnostics-dir', 'concurrency', 'codex', 'force']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force') {
      options.force = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument ${argument}\n${usage()}`);
    const name = argument.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option ${argument}\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}\n${usage()}`);
    options[name] = value;
    index += 1;
  }
  for (const name of ['task-dir', 'result-dir', 'transcript-dir', 'diagnostics-dir']) {
    if (typeof options[name] !== 'string' || options[name] === '') throw new Error(`Missing --${name}\n${usage()}`);
  }
  const concurrency = options.concurrency === undefined ? 2 : Number(options.concurrency);
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error('--concurrency must be a positive integer');
  return { ...options, concurrency };
}

function fileStem(runId) {
  return `${runId.replace(/[^a-zA-Z0-9._-]+/g, '_')}-${createHash('sha256').update(runId).digest('hex').slice(0, 12)}`;
}

async function writeFileExclusive(filePath, text, force) {
  await writeFile(filePath, text, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
}

export async function runBatch(tasks, options) {
  const concurrency = options.concurrency ?? 2;
  const results = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      const task = tasks[index];
      const execution = await runCodexTask(task, {
        executable: options.executable,
        outputSchemaPath: options.outputSchemaPath,
      });
      const stem = fileStem(task.run.runId);
      const resultPath = path.join(options.resultDirectory, `${stem}.json`);
      const transcriptPath = path.join(options.transcriptDirectory, `${stem}.jsonl`);
      const diagnosticsPath = path.join(options.diagnosticsDirectory, `${stem}.log`);
      await writeFileExclusive(resultPath, `${JSON.stringify(execution.result, null, 2)}\n`, options.force === true);
      await writeFileExclusive(transcriptPath, execution.transcript, options.force === true);
      await writeFileExclusive(diagnosticsPath, execution.diagnostics, options.force === true);
      results[index] = {
        runId: task.run.runId,
        status: execution.result.status,
        resultPath,
        transcriptPath,
        diagnosticsPath,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, () => worker()));
  return results;
}

async function readTasks(directory) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) throw new Error(`No JSON task files found in ${directory}`);
  return Promise.all(names.map(async (name) => {
    const filePath = path.join(directory, name);
    try {
      return validateRunnerTask(JSON.parse(await readFile(filePath, 'utf8')));
    } catch (error) {
      throw new Error(`Cannot read task ${filePath}: ${error.message}`);
    }
  }));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const taskDirectory = path.resolve(options['task-dir']);
  const resultDirectory = path.resolve(options['result-dir']);
  const transcriptDirectory = path.resolve(options['transcript-dir']);
  const diagnosticsDirectory = path.resolve(options['diagnostics-dir']);
  await Promise.all([resultDirectory, transcriptDirectory, diagnosticsDirectory].map((directory) => mkdir(directory, { recursive: true })));
  const tasks = await readTasks(taskDirectory);
  const manifest = await runBatch(tasks, {
    concurrency: options.concurrency,
    executable: options.codex ?? 'codex.cmd',
    outputSchemaPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'codex-output.schema.json'),
    resultDirectory,
    transcriptDirectory,
    diagnosticsDirectory,
    force: options.force === true,
  });
  const manifestPath = path.join(resultDirectory, 'batch-manifest.json');
  await writeFileExclusive(manifestPath, `${JSON.stringify({ schemaVersion: 1, runCount: manifest.length, runs: manifest }, null, 2)}\n`, options.force === true);
  process.stdout.write(`${JSON.stringify({ runCount: manifest.length, manifest: manifestPath })}\n`);
  if (manifest.some((item) => item.status !== 'completed')) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
