#!/usr/bin/env node

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/index.js';
import {
  auditSchemaCoverage,
  compareAuditBaselines,
  formatAuditFields,
  formatAuditSummary,
  toAuditBaseline,
} from '../dist/schema-audit.js';
import { SCHEMA_AUDIT_MAPPINGS } from '../dist/schema-audit-mappings.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.dirname(SCRIPT_DIR);
const DEFAULT_SPEC = path.join(REPO_DIR, 'api-spec', 'openapi.json');
const DEFAULT_BASELINE = path.join(REPO_DIR, 'api-spec', 'tool-schema-coverage.json');

function usage() {
  return [
    'Usage: node scripts/audit-tool-schemas.mjs [options]',
    '',
    'Options:',
    '  --update             Replace the opaque baseline with the current result',
    '  --show-fields        Print raw missing field names locally; never writes baseline',
    '  --spec <path>        Read a different local OpenAPI document',
    '  --baseline <path>    Read or update a different baseline',
    '  --help               Show this help',
    '',
  ].join('\n');
}

function parseArgs(args) {
  const options = {
    update: false,
    showFields: false,
    specPath: DEFAULT_SPEC,
    baselinePath: DEFAULT_BASELINE,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--update') options.update = true;
    else if (arg === '--show-fields') options.showFields = true;
    else if (arg === '--spec' || arg === '--baseline') {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      if (arg === '--spec') options.specPath = path.resolve(value);
      else options.baselinePath = path.resolve(value);
      index += 1;
    } else if (arg === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.update && options.showFields) {
    throw new Error('--update and --show-fields cannot be combined');
  }
  return options;
}

async function readJson(filePath, description) {
  let contents;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${description} not found at ${filePath}`);
    throw new Error(`Could not read ${description} at ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${error.message}`);
  }
}

async function discoverTools() {
  const server = createServer({
    transport: async () => {
      throw new Error('Schema discovery must not make Fortnox requests');
    },
  });
  const client = new Client({ name: 'noxctl-schema-audit', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [spec, tools] = await Promise.all([
    readJson(options.specPath, 'OpenAPI specification'),
    discoverTools(),
  ]);
  const results = auditSchemaCoverage(spec, tools, SCHEMA_AUDIT_MAPPINGS);
  const current = toAuditBaseline(results);

  if (options.showFields) {
    process.stdout.write(formatAuditFields(results));
    return;
  }

  if (options.update) {
    await writeJsonAtomically(options.baselinePath, current);
    process.stdout.write(formatAuditSummary(results));
    return;
  }

  const expected = await readJson(options.baselinePath, 'Schema-audit baseline');
  const comparison = compareAuditBaselines(expected, current);
  process.stdout.write(formatAuditSummary(results, comparison));
  if (!comparison.matches) {
    process.stderr.write(`Changed mappings: ${comparison.changedMappingIds.join(', ')}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`Schema audit failed: ${error.message}\n`);
  process.exitCode = 2;
});
