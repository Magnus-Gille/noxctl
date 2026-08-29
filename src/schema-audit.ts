import { createHash } from 'node:crypto';

const HASH_DOMAIN = 'noxctl-openapi-tool-schema-audit/v1';

type JsonObject = Record<string, unknown>;

export interface DiscoveredToolSchema {
  name: string;
  inputSchema: JsonObject;
}

export interface SchemaAuditMapping {
  /** Stable public identifier used in logs and the opaque baseline. */
  id: string;
  toolName: string;
  /** JSON Pointer from the tool's inputSchema to the object being compared. */
  toolSchemaPointer: string;
  /** Component name under components.schemas in the local OpenAPI cache. */
  specSchemaName: string;
  ignoredProperties?: readonly string[];
}

export interface SchemaAuditResult {
  id: string;
  declaredPropertyCount: number;
  specificationPropertyCount: number;
  ignoredProperties: string[];
  missingProperties: string[];
  stateHash: string;
}

export interface SchemaAuditBaselineRecord {
  id: string;
  declaredPropertyCount: number;
  specificationPropertyCount: number;
  missingPropertyCount: number;
  stateHash: string;
}

export interface SchemaAuditBaseline {
  formatVersion: 1;
  records: SchemaAuditBaselineRecord[];
}

export interface SchemaAuditComparison {
  matches: boolean;
  changedMappingIds: string[];
}

function asObject(value: unknown, description: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} is not an object`);
  }
  return value as JsonObject;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolvePointer(root: unknown, pointer: string, description: string): unknown {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) {
    throw new Error(`${description} pointer must be empty or start with "/"`);
  }

  let current = root;
  for (const encodedSegment of pointer.slice(1).split('/')) {
    const segment = decodePointerSegment(encodedSegment);
    const object = asObject(current, `${description} pointer parent`);
    if (!Object.hasOwn(object, segment)) {
      throw new Error(`${description} pointer not found`);
    }
    current = object[segment];
  }
  return current;
}

function sortedPropertyNames(schema: unknown, description: string): string[] {
  const object = asObject(schema, description);
  const properties = asObject(object['properties'], `${description} properties`);
  return Object.keys(properties).sort(compareText);
}

function stateHash(mappingId: string, ignored: string[], missing: string[]): string {
  const canonical = JSON.stringify({
    domain: HASH_DOMAIN,
    mappingId,
    ignored,
    missing,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function auditSchemaCoverage(
  spec: unknown,
  tools: readonly DiscoveredToolSchema[],
  mappings: readonly SchemaAuditMapping[],
): SchemaAuditResult[] {
  const specObject = asObject(spec, 'OpenAPI document');
  const components = asObject(specObject['components'], 'OpenAPI components');
  const schemas = asObject(components['schemas'], 'OpenAPI component schemas');
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const seenIds = new Set<string>();

  const results = mappings.map((mapping) => {
    if (seenIds.has(mapping.id)) {
      throw new Error(`Duplicate schema-audit mapping id: ${mapping.id}`);
    }
    seenIds.add(mapping.id);

    const tool = toolsByName.get(mapping.toolName);
    if (!tool) throw new Error(`Mapped tool not found: ${mapping.id}`);

    if (!Object.hasOwn(schemas, mapping.specSchemaName)) {
      throw new Error(`Mapped OpenAPI schema not found: ${mapping.id}`);
    }

    const toolSchema = resolvePointer(
      tool.inputSchema,
      mapping.toolSchemaPointer,
      `Tool schema for ${mapping.id}`,
    );
    const declared = sortedPropertyNames(toolSchema, `Tool schema for ${mapping.id}`);
    const specification = sortedPropertyNames(
      schemas[mapping.specSchemaName],
      `OpenAPI schema for ${mapping.id}`,
    );
    const ignored = [...new Set(mapping.ignoredProperties ?? [])].sort(compareText);
    const declaredSet = new Set(declared);
    const ignoredSet = new Set(ignored);
    const missing = specification.filter(
      (property) => !declaredSet.has(property) && !ignoredSet.has(property),
    );

    return {
      id: mapping.id,
      declaredPropertyCount: declared.length,
      specificationPropertyCount: specification.length,
      ignoredProperties: ignored,
      missingProperties: missing,
      stateHash: stateHash(mapping.id, ignored, missing),
    };
  });

  return results.sort((a, b) => compareText(a.id, b.id));
}

export function toAuditBaseline(results: readonly SchemaAuditResult[]): SchemaAuditBaseline {
  return {
    formatVersion: 1,
    records: [...results]
      .sort((a, b) => compareText(a.id, b.id))
      .map((result) => ({
        id: result.id,
        declaredPropertyCount: result.declaredPropertyCount,
        specificationPropertyCount: result.specificationPropertyCount,
        missingPropertyCount: result.missingProperties.length,
        stateHash: result.stateHash,
      })),
  };
}

function recordsById(baseline: SchemaAuditBaseline): Map<string, SchemaAuditBaselineRecord> {
  return new Map(baseline.records.map((record) => [record.id, record]));
}

export function compareAuditBaselines(
  expected: SchemaAuditBaseline,
  current: SchemaAuditBaseline,
): SchemaAuditComparison {
  const expectedById = recordsById(expected);
  const currentById = recordsById(current);
  const ids = new Set([...expectedById.keys(), ...currentById.keys()]);
  const changedMappingIds = [...ids]
    .filter((id) => JSON.stringify(expectedById.get(id)) !== JSON.stringify(currentById.get(id)))
    .sort(compareText);

  return {
    matches: expected.formatVersion === current.formatVersion && changedMappingIds.length === 0,
    changedMappingIds:
      expected.formatVersion === current.formatVersion
        ? changedMappingIds
        : ['$format', ...changedMappingIds],
  };
}

export function formatAuditSummary(
  results: readonly SchemaAuditResult[],
  comparison?: SchemaAuditComparison,
): string {
  const status = comparison ? (comparison.matches ? 'ok' : 'drift') : 'generated';
  const lines = [`Schema audit: ${status}`];
  for (const result of [...results].sort((a, b) => compareText(a.id, b.id))) {
    lines.push(
      `${result.id}: declared=${result.declaredPropertyCount} spec=${result.specificationPropertyCount} missing=${result.missingProperties.length} state=${result.stateHash}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatAuditFields(results: readonly SchemaAuditResult[]): string {
  const lines: string[] = [];
  for (const result of [...results].sort((a, b) => compareText(a.id, b.id))) {
    lines.push(`${result.id}:`);
    // Property names originate in a fetched document. JSON quoting preserves
    // their exact value while preventing terminal control-sequence injection.
    lines.push(...result.missingProperties.map((property) => `  - ${JSON.stringify(property)}`));
    if (result.missingProperties.length === 0) lines.push('  (none)');
  }
  return `${lines.join('\n')}\n`;
}
