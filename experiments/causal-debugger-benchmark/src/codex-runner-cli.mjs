#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCodexTask, validateRunnerTask } from './codex-runner.mjs';

function usage() {
  return 'Usage: node src/codex-runner-cli.mjs --task <runner-task.json> --out <run-result.json> --transcript <events.jsonl> --diagnostics <stderr.log> [--codex <codex.cmd>] [--force]';
}

function parseArguments(argv) {
  const options = {};
  const allowed = new Set(['task', 'out', 'transcript', 'diagnostics', 'codex', 'force']);
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
  return options;
}

function requirePath(options, name) {
  if (typeof options[name] !== 'string' || options[name] === '') throw new Error(`Missing --${name}\n${usage()}`);
  return path.resolve(options[name]);
}

async function readJson(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

async function writeOutput(filePath, contents, force) {
  try {
    await writeFile(filePath, contents, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Refusing to overwrite ${filePath}; pass --force to replace it`);
    throw new Error(`Cannot write ${filePath}: ${error.message}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const taskPath = requirePath(options, 'task');
  const outputPath = requirePath(options, 'out');
  const transcriptPath = requirePath(options, 'transcript');
  const diagnosticsPath = requirePath(options, 'diagnostics');
  const task = validateRunnerTask(await readJson(taskPath));
  const outputSchemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'codex-output.schema.json');
  const execution = await runCodexTask(task, {
    executable: options.codex ?? 'codex.cmd',
    outputSchemaPath,
  });
  await writeOutput(outputPath, `${JSON.stringify(execution.result, null, 2)}\n`, options.force === true);
  await writeOutput(transcriptPath, execution.transcript, options.force === true);
  await writeOutput(diagnosticsPath, execution.diagnostics, options.force === true);
  process.stdout.write(`${JSON.stringify({ runId: task.run.runId, status: execution.result.status })}\n`);
  if (execution.result.status !== 'completed') process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
});
