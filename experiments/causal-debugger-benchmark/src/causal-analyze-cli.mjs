#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { buildAnalysisFromCodeGraph } from './codegraph-adapter.mjs';

function usage() {
  return [
    'Usage:',
    '  node src/causal-analyze-cli.mjs --project <dir> --query <text> [--query <text> ...] [options]',
    'Options:',
    '  --seed-id <id>       Use an exact CodeGraph node ID (repeatable)',
    '  --runtime-evidence <json>  Read normalized runtime evidence JSON',
    '  --sdk-path <file>    Explicit CodeGraph public SDK path',
    '  --max-depth <n>      Reverse graph depth (default: 3)',
    '  --limit <n>          Maximum materialized nodes (default: 250)',
    '  --beam-width <n>     Causal hypothesis beam width (default: 24)',
    '  --out <file>         Write JSON instead of stdout',
    '  --force              Allow replacing --out',
  ].join('\n');
}

function parseArguments(argv) {
  const options = { query: [], 'seed-id': [] };
  const valued = new Set(['project', 'query', 'seed-id', 'runtime-evidence', 'sdk-path', 'max-depth', 'limit', 'beam-width', 'out']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force') { options.force = true; continue; }
    if (!argument.startsWith('--') || !valued.has(argument.slice(2))) throw new Error(`Unknown option ${argument}\n${usage()}`);
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}\n${usage()}`);
    if (name === 'query' || name === 'seed-id') options[name].push(value);
    else options[name] = value;
    index += 1;
  }
  if (!options.project || options.query.length === 0) throw new Error(`--project and at least one --query are required\n${usage()}`);
  return options;
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) { throw new Error(`Cannot read JSON ${filePath}: ${error.message}`); }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const runtimeEvidence = options['runtime-evidence'] ? await readJson(path.resolve(options['runtime-evidence'])) : [];
  const numeric = (name, fallback) => options[name] === undefined ? fallback : Number.parseInt(options[name], 10);
  const engineOptions = { maxDepth: numeric('max-depth', 3), beamWidth: numeric('beam-width', 24) };
  if (!Number.isInteger(engineOptions.maxDepth) || engineOptions.maxDepth < 0) throw new Error('--max-depth must be a non-negative integer');
  if (!Number.isInteger(engineOptions.beamWidth) || engineOptions.beamWidth < 1) throw new Error('--beam-width must be a positive integer');
  const result = await buildAnalysisFromCodeGraph({
    projectRoot: path.resolve(options.project),
    seedQueries: options.query,
    seedIds: options['seed-id'],
    sdkPath: options['sdk-path'] ? path.resolve(options['sdk-path']) : undefined,
    limit: numeric('limit', 250),
    maxDepth: engineOptions.maxDepth,
    runtimeEvidence,
    engineOptions,
  });
  const output = JSON.stringify(result, null, 2) + '\n';
  if (options.out) {
    await writeFile(path.resolve(options.out), output, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' });
  } else process.stdout.write(output);
}

main().catch((error) => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; });
