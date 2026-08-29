import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import {
  auditSchemaCoverage,
  compareAuditBaselines,
  formatAuditFields,
  formatAuditSummary,
  toAuditBaseline,
  type SchemaAuditMapping,
} from '../src/schema-audit.js';
import { SCHEMA_AUDIT_MAPPINGS } from '../src/schema-audit-mappings.js';

const mapping: SchemaAuditMapping = {
  id: 'example-row',
  toolName: 'fortnox_create_example',
  toolSchemaPointer: '/properties/Rows/items',
  specSchemaName: 'ExampleRow',
  ignoredProperties: ['IgnoredByDesign'],
};

function syntheticInputs() {
  return {
    tools: [
      {
        name: 'fortnox_create_example',
        inputSchema: {
          type: 'object',
          properties: {
            Rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  Present: { type: 'string' },
                },
              },
            },
          },
        },
      },
    ],
    spec: {
      components: {
        schemas: {
          ExampleRow: {
            type: 'object',
            properties: {
              Present: { type: 'string' },
              Missing: { type: 'number' },
              IgnoredByDesign: { type: 'boolean' },
            },
          },
        },
      },
    },
  };
}

describe('OpenAPI tool-schema audit', () => {
  it('finds missing properties and applies explicit ignores', () => {
    const { spec, tools } = syntheticInputs();

    const [result] = auditSchemaCoverage(spec, tools, [mapping]);

    expect(result).toMatchObject({
      id: 'example-row',
      declaredPropertyCount: 1,
      specificationPropertyCount: 3,
      missingProperties: ['Missing'],
    });
  });

  it('produces deterministic, domain-separated hashes that include mapping and ignores', () => {
    const { spec, tools } = syntheticInputs();
    const first = toAuditBaseline(auditSchemaCoverage(spec, tools, [mapping]));
    const second = toAuditBaseline(auditSchemaCoverage(spec, tools, [mapping]));
    const changedId = toAuditBaseline(
      auditSchemaCoverage(spec, tools, [{ ...mapping, id: 'another-row' }]),
    );
    const changedIgnores = toAuditBaseline(
      auditSchemaCoverage(spec, tools, [{ ...mapping, ignoredProperties: [] }]),
    );

    expect(second).toEqual(first);
    expect(changedId.records[0]?.stateHash).not.toBe(first.records[0]?.stateHash);
    expect(changedIgnores.records[0]?.stateHash).not.toBe(first.records[0]?.stateHash);
    expect(JSON.stringify(first)).not.toContain('Missing');
    expect(JSON.stringify(first)).not.toContain('IgnoredByDesign');
    expect(JSON.stringify(first)).not.toContain('Present');
  });

  it('detects baseline drift without disclosing property names in normal output', () => {
    const { spec, tools } = syntheticInputs();
    const results = auditSchemaCoverage(spec, tools, [mapping]);
    const current = toAuditBaseline(results);
    const expected = structuredClone(current);
    expected.records[0]!.missingPropertyCount = 2;

    const comparison = compareAuditBaselines(expected, current);
    const output = formatAuditSummary(results, comparison);

    expect(comparison).toEqual({ matches: false, changedMappingIds: ['example-row'] });
    expect(output).toContain('example-row');
    expect(output).toContain('drift');
    expect(output).not.toContain('Missing');
    expect(output).not.toContain('IgnoredByDesign');
    expect(output).not.toContain('Present');
  });

  it('reveals raw names only through the explicit field formatter', () => {
    const { spec, tools } = syntheticInputs();
    const results = auditSchemaCoverage(spec, tools, [mapping]);

    expect(formatAuditFields(results)).toContain('Missing');
  });

  it('escapes control characters in explicit field diagnostics', () => {
    const { spec, tools } = syntheticInputs();
    const properties = spec.components.schemas.ExampleRow.properties;
    Object.assign(properties, { '\u001b[31mDanger\u001b[0m\nField': { type: 'string' } });

    const output = formatAuditFields(auditSchemaCoverage(spec, tools, [mapping]));

    expect(output).not.toContain('\u001b');
    expect(output).toContain('\\u001b[31mDanger\\u001b[0m\\nField');
  });

  it('fails closed when a tool, pointer, or OpenAPI component cannot be resolved', () => {
    const { spec, tools } = syntheticInputs();

    expect(() => auditSchemaCoverage(spec, [], [mapping])).toThrow(/tool.*not found/i);
    expect(() =>
      auditSchemaCoverage(spec, tools, [
        { ...mapping, toolSchemaPointer: '/properties/Unknown/items' },
      ]),
    ).toThrow(/pointer.*not found/i);
    expect(() =>
      auditSchemaCoverage(spec, tools, [{ ...mapping, specSchemaName: 'Unknown' }]),
    ).toThrow(/schema.*not found/i);
  });

  it('sorts mappings and properties for byte-stable baseline serialization', () => {
    const { spec, tools } = syntheticInputs();
    const other = { ...mapping, id: 'aaa-example-row' };
    const baseline = toAuditBaseline(auditSchemaCoverage(spec, tools, [mapping, other]));

    expect(baseline.formatVersion).toBe(1);
    expect(baseline.records.map((record) => record.id)).toEqual(['aaa-example-row', 'example-row']);
    expect(`${JSON.stringify(baseline, null, 2)}\n`).toBe(
      `${JSON.stringify(toAuditBaseline(auditSchemaCoverage(spec, tools, [other, mapping])), null, 2)}\n`,
    );
  });

  it('resolves every production mapping against the actual discovered MCP schemas', async () => {
    const server = createServer({
      transport: async () => {
        throw new Error('Unexpected Fortnox request');
      },
    });
    const client = new Client({ name: 'schema-audit-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      const schemas = Object.fromEntries(
        SCHEMA_AUDIT_MAPPINGS.map(({ specSchemaName }) => [
          specSchemaName,
          { type: 'object', properties: {} },
        ]),
      );

      const results = auditSchemaCoverage(
        { components: { schemas } },
        tools,
        SCHEMA_AUDIT_MAPPINGS,
      );

      expect(results).toHaveLength(6);
      expect(results.every((result) => result.declaredPropertyCount > 0)).toBe(true);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
