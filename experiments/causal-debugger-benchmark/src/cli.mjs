#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  auditEvidencePackets,
  collectRunResults,
  createRunPlan,
  createRunnerTask,
  evaluateResults,
  validateSuite,
} from './benchmark.mjs';

function usage() {
  return [
    'Usage:',
    '  node src/cli.mjs validate --suite <suite.json>',
    '  node src/cli.mjs plan --suite <suite.json> --out <run-plan.json> [--force]',
    '  node src/cli.mjs task --suite <suite.json> --plan <run-plan.json> --run-id <run-id> --out <runner-task.json> [--force]',
    '  node src/cli.mjs collect --suite <suite.json> --plan <run-plan.json> --run-result <run-result.json> [--run-result <run-result.json> ...] --out <results.json> [--force]',
    '  node src/cli.mjs evaluate --suite <suite.json> --plan <run-plan.json> --results <results.json> --out <report.json> [--force] [--allow-non-go]',
  ].join('\n');
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || !['validate', 'plan', 'task', 'collect', 'evaluate'].includes(command)) throw new Error(usage());
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--force' || argument === '--allow-non-go') {
      options[argument.slice(2)] = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument ${argument}\n${usage()}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}\n${usage()}`);
    const name = argument.slice(2);
    if (name === 'run-result') {
      options[name] ??= [];
      options[name].push(value);
    } else {
      options[name] = value;
    }
    index += 1;
  }
  const allowedByCommand = {
    validate: new Set(['suite']),
    plan: new Set(['suite', 'out', 'force']),
    task: new Set(['suite', 'plan', 'run-id', 'out', 'force']),
    collect: new Set(['suite', 'plan', 'run-result', 'out', 'force']),
    evaluate: new Set(['suite', 'plan', 'results', 'out', 'force', 'allow-non-go']),
  };
  for (const name of Object.keys(options)) {
    if (!allowedByCommand[command].has(name)) throw new Error(`Unknown option --${name} for ${command}\n${usage()}`);
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value === '') throw new Error(`Missing --${name}\n${usage()}`);
  return path.resolve(value);
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

async function writeJson(filePath, value, force) {
  const flag = force ? 'w' : 'wx';
  try {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Refusing to overwrite ${filePath}; pass --force to replace it`);
    throw new Error(`Cannot write ${filePath}: ${error.message}`);
  }
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const suitePath = requireOption(options, 'suite');
  const suite = await readJson(suitePath);
  const baseDirectory = path.dirname(suitePath);

  if (command === 'validate') {
    const validated = validateSuite(suite);
    const summary = {
      valid: true,
      suiteId: validated.suiteId,
      mode: validated.mode,
      caseCount: validated.cases.length,
      holdoutCount: validated.cases.filter((item) => item.split === 'holdout').length,
      repetitions: validated.repetitions,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  if (command === 'plan') {
    const outputPath = requireOption(options, 'out');
    const plan = createRunPlan(suite, { baseDirectory });
    await writeJson(outputPath, plan, options.force === true);
    process.stdout.write(`${JSON.stringify({ planId: plan.planId, runCount: plan.runOrder.length })}\n`);
    return;
  }

  if (command === 'task') {
    const planPath = requireOption(options, 'plan');
    const outputPath = requireOption(options, 'out');
    const runId = options['run-id'];
    if (typeof runId !== 'string' || runId === '') throw new Error(`Missing --run-id\n${usage()}`);
    const plan = await readJson(planPath);
    const task = createRunnerTask(suite, plan, runId, { baseDirectory });
    await writeJson(outputPath, task, options.force === true);
    process.stdout.write(`${JSON.stringify({ planId: task.planId, runId })}\n`);
    return;
  }

  if (command === 'collect') {
    const planPath = requireOption(options, 'plan');
    const outputPath = requireOption(options, 'out');
    const runResultPaths = options['run-result'];
    if (!Array.isArray(runResultPaths) || runResultPaths.length === 0) {
      throw new Error(`Missing --run-result\n${usage()}`);
    }
    const plan = await readJson(planPath);
    const runResults = await Promise.all(runResultPaths.map((item) => readJson(path.resolve(item))));
    const results = collectRunResults(suite, plan, runResults, { baseDirectory });
    await writeJson(outputPath, results, options.force === true);
    process.stdout.write(`${JSON.stringify({ planId: results.planId, runCount: results.runs.length })}\n`);
    return;
  }

  const planPath = requireOption(options, 'plan');
  const resultsPath = requireOption(options, 'results');
  const outputPath = requireOption(options, 'out');
  const plan = await readJson(planPath);
  const results = await readJson(resultsPath);
  const evidenceAudit = await auditEvidencePackets(suite, plan, { baseDirectory });
  const report = evaluateResults(suite, plan, results, { baseDirectory, evidenceAudit });
  await writeJson(outputPath, report, options.force === true);
  process.stdout.write(`${JSON.stringify({ decision: report.decision, report: outputPath })}\n`);
  if (report.decision !== 'go' && options['allow-non-go'] !== true) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
});
