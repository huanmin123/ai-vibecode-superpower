#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createEvidencePacket } from './benchmark.mjs';

function usage() {
  return [
    'Usage:',
    '  node src/evidence-packet-cli.mjs --source <raw-context.txt> --query <query> --elapsed-ms <ms> --claim <json> [--claim <json> ...] --out <packet.json> [--force]',
  ].join('\n');
}

function parseArguments(argv) {
  const options = { claim: [] };
  const allowed = new Set(['source', 'query', 'elapsed-ms', 'claim', 'out', 'force']);
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
    if (name === 'claim') options.claim.push(value);
    else options[name] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  if (typeof options[name] !== 'string' || options[name] === '') throw new Error(`Missing --${name}\n${usage()}`);
  return options[name];
}

async function writeJson(outputPath, value, force) {
  try {
    await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Refusing to overwrite ${outputPath}; pass --force to replace it`);
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourcePath = path.resolve(requireOption(options, 'source'));
  const outputPath = path.resolve(requireOption(options, 'out'));
  const rawClaims = options.claim.map((text, index) => {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON for --claim #${index + 1}: ${error.message}`);
    }
  });
  const source = await readFile(sourcePath, 'utf8');
  const packet = createEvidencePacket({
    elapsedMs: Number(requireOption(options, 'elapsed-ms')),
    generator: 'codegraph-cli-1.5.0',
    query: requireOption(options, 'query'),
    content: source,
    claims: rawClaims,
  });
  await writeJson(outputPath, packet, options.force === true);
  process.stdout.write(`${JSON.stringify({ packet: outputPath, claims: packet.claims.length, characters: packet.content.length })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
});
