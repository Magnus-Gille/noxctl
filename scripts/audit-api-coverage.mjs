#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/index.js';
import { defaultFortnoxOperations } from '../dist/operations/index.js';
import {
  calculateApiCoverage,
  compareApiCoverageBaselines,
  formatApiCoverageDetails,
  formatApiCoverageSummary,
  toApiCoverageBaseline,
} from '../dist/api-coverage.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.dirname(SCRIPT_DIR);
const DEFAULT_SPEC = path.join(REPO_DIR, 'api-spec', 'openapi.json');
const DEFAULT_MAP = path.join(REPO_DIR, 'api-spec', 'api-implementation-map.json');
const DEFAULT_BASELINE = path.join(REPO_DIR, 'api-spec', 'api-implementation-coverage.json');
const HTTP_METHODS = new Set(['delete', 'get', 'patch', 'post', 'put']);

const hash = (...parts) =>
  createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
const tagIdentity = (tag) => hash('noxctl-api-family/v1', tag);
const operationIdentity = (method, route, operationId) =>
  hash('noxctl-api-operation/v1', method.toUpperCase(), route, operationId ?? '');

function usage() {
  return [
    'Usage: node scripts/audit-api-coverage.mjs [options]',
    '',
    'Options:',
    '  --offline            Verify committed mapping and implementation evidence without the local spec',
    '  --update             Replace the opaque baseline with the current result',
    '  --show-details       Print raw local API details; never writes a baseline',
    '  --spec <path>        Read a different local OpenAPI document',
    '  --map <path>         Read a different opaque implementation map',
    '  --baseline <path>    Read or update a different opaque baseline',
    '  --help               Show this help',
    '',
  ].join('\n');
}

function parseArgs(args) {
  const options = {
    offline: false,
    update: false,
    showDetails: false,
    specPath: DEFAULT_SPEC,
    mapPath: DEFAULT_MAP,
    baselinePath: DEFAULT_BASELINE,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--offline') options.offline = true;
    else if (arg === '--update') options.update = true;
    else if (arg === '--show-details') options.showDetails = true;
    else if (['--spec', '--map', '--baseline'].includes(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      options[`${arg.slice(2)}Path`] = path.resolve(value);
      index += 1;
    } else if (arg === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.update && options.showDetails) {
    throw new Error('--update and --show-details cannot be combined');
  }
  if (options.offline && options.showDetails) {
    throw new Error('--offline and --show-details cannot be combined');
  }
  return options;
}

async function readJson(filePath, description) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${description} not found at ${filePath}`);
    throw new Error(`Could not read ${description}: ${error.message}`);
  }
}

function inspectSpec(spec) {
  const families = new Map();
  for (const [route, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      for (const tag of operation.tags ?? ['(untagged)']) {
        const tagHash = tagIdentity(tag);
        const family = families.get(tagHash) ?? { tag, operations: [] };
        family.operations.push({
          identity: operationIdentity(method, route, operation.operationId),
          method: method.toUpperCase(),
          route,
          operationId: operation.operationId ?? '',
        });
        families.set(tagHash, family);
      }
    }
  }
  return families;
}

function mappingsFromDocument(document) {
  if (document?.formatVersion !== 1 || !Array.isArray(document.families)) {
    throw new Error('Implementation map has an unsupported format');
  }
  const tagHashes = new Set();
  const ids = new Set();
  return document.families.map((family) => {
    if (!family.id || !family.tagHash || ids.has(family.id) || tagHashes.has(family.tagHash)) {
      throw new Error('Implementation map has a missing or duplicate family identity');
    }
    ids.add(family.id);
    tagHashes.add(family.tagHash);
    return {
      tagHash: family.tagHash,
      mapping: {
        id: family.id,
        classification: family.classification,
        publicOperationCount:
          family.operations.implemented.length +
          family.operations.missing.length +
          family.operations.excluded.length,
        implementedOperationIdentities: family.operations.implemented,
        missingOperationIdentities: family.operations.missing,
        excludedOperationIdentities: family.operations.excluded,
        evidence: family.evidence,
        rationale: family.rationale,
      },
    };
  });
}

function verifySpecCoverage(mapped, inspected) {
  const byTagHash = new Map(mapped.map((entry) => [entry.tagHash, entry]));
  const unknown = [...inspected.keys()].filter((identity) => !byTagHash.has(identity));
  const removed = [...byTagHash.keys()].filter((identity) => !inspected.has(identity));
  if (unknown.length || removed.length) {
    throw new Error(
      `API family inventory drift: new=${unknown.length} removed=${removed.length}; use --show-details locally`,
    );
  }
  for (const [tagHash, entry] of byTagHash) {
    const actual = new Set(inspected.get(tagHash).operations.map(({ identity }) => identity));
    const mappedOperations = [
      ...entry.mapping.implementedOperationIdentities,
      ...entry.mapping.missingOperationIdentities,
      ...entry.mapping.excludedOperationIdentities,
    ];
    const stale = mappedOperations.filter((identity) => !actual.has(identity));
    const unmapped = [...actual].filter((identity) => !mappedOperations.includes(identity));
    if (stale.length || unmapped.length) {
      throw new Error(
        `API operation inventory drift for ${entry.mapping.id}: new=${unmapped.length} removed=${stale.length}; use --show-details locally`,
      );
    }
  }
}

async function discoverTools() {
  const server = createServer({
    transport: async () => {
      throw new Error('Coverage discovery must not make Fortnox requests');
    },
  });
  const client = new Client({ name: 'noxctl-api-coverage-audit', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.listTools()).tools.map(({ name }) => name);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function verifyEvidence(mapped) {
  const operationExports = new Set(Object.keys(defaultFortnoxOperations));
  const mcpTools = new Set(await discoverTools());
  for (const { mapping } of mapped) {
    const evidence = mapping.evidence;
    for (const name of evidence?.operationExports ?? []) {
      if (!operationExports.has(name)) throw new Error(`Missing operation evidence: ${mapping.id}`);
    }
    for (const name of evidence?.mcpTools ?? []) {
      if (!mcpTools.has(name)) throw new Error(`Missing MCP evidence: ${mapping.id}`);
    }
    for (const command of evidence?.cliCommands ?? []) {
      const outcome = spawnSync(process.execPath, [path.join(REPO_DIR, 'dist', 'cli.js'), ...command, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, NOXCTL_PROFILE: 'default' },
      });
      if (outcome.status !== 0) throw new Error(`Missing CLI evidence: ${mapping.id}`);
    }
  }
}

function detailedInventory(mapped, inspected) {
  const byHash = new Map(mapped.map((entry) => [entry.tagHash, entry]));
  const lines = [];
  for (const [tagHash, family] of inspected) {
    const entry = byHash.get(tagHash);
    lines.push(`${JSON.stringify(family.tag)} -> ${entry?.mapping.id ?? '(unmapped)'}`);
    const states = entry
      ? new Map([
          ...entry.mapping.implementedOperationIdentities.map((identity) => [identity, 'implemented']),
          ...entry.mapping.missingOperationIdentities.map((identity) => [identity, 'missing']),
          ...entry.mapping.excludedOperationIdentities.map((identity) => [identity, 'excluded']),
        ])
      : new Map();
    for (const operation of family.operations) {
      lines.push(
        `  ${states.get(operation.identity) ?? 'unmapped'} ${operation.method} ${JSON.stringify(operation.route)} ${JSON.stringify(operation.operationId)}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const document = await readJson(options.mapPath, 'Implementation map');
  const mapped = mappingsFromDocument(document);
  let inspected;
  if (!options.offline) {
    inspected = inspectSpec(await readJson(options.specPath, 'OpenAPI specification'));
    verifySpecCoverage(mapped, inspected);
  }
  await verifyEvidence(mapped);
  const results = calculateApiCoverage(mapped.map(({ mapping }) => mapping));
  const current = toApiCoverageBaseline(results);

  if (options.showDetails) {
    process.stdout.write(detailedInventory(mapped, inspected));
    process.stdout.write(formatApiCoverageDetails(results));
    return;
  }
  if (options.update) {
    await writeJsonAtomically(options.baselinePath, current);
    process.stdout.write(formatApiCoverageSummary(results));
    return;
  }
  const expected = await readJson(options.baselinePath, 'API coverage baseline');
  const comparison = compareApiCoverageBaselines(expected, current);
  process.stdout.write(formatApiCoverageSummary(results, comparison));
  if (!comparison.matches) {
    process.stderr.write(`Changed mappings: ${comparison.changedMappingIds.join(', ')}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`API coverage audit failed: ${error.message}\n`);
  process.exitCode = 2;
});
