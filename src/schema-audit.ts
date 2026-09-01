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
  /** Opaque, reviewed exceptions for compatibility differences that are intentional. */
  compatibilityExceptions?: readonly SchemaAuditCompatibilityException[];
}

export type SchemaAuditDimension =
  | 'field'
  | 'nesting'
  | 'requiredness'
  | 'type'
  | 'enum'
  | 'nullability'
  | 'constraint'
  | 'strictness';

export interface SchemaAuditCompatibilityException {
  issueHash: string;
  rationale: string;
}

export interface MutationAuditException {
  id: string;
  toolName: string;
  kind: 'no-structured-body' | 'binary-or-local-file' | 'passthrough';
  rationale: string;
  preservationTest?: string;
}

export interface SchemaAuditResult {
  id: string;
  declaredPropertyCount: number;
  specificationPropertyCount: number;
  ignoredProperties: string[];
  missingProperties: string[];
  checkedNodeCount: number;
  compatibilityIssueCount: number;
  resultClass: 'compatible' | 'tracked-gap';
  issuesByDimension: Record<SchemaAuditDimension, string[]>;
  stateHash: string;
}

export interface SchemaAuditBaselineRecord {
  id: string;
  declaredPropertyCount: number;
  specificationPropertyCount: number;
  missingPropertyCount: number;
  checkedNodeCount: number;
  issuesByDimension: Record<SchemaAuditDimension, number>;
  resultClass: 'compatible' | 'tracked-gap';
  stateHash: string;
}

export interface SchemaAuditBaseline {
  formatVersion: 2;
  records: SchemaAuditBaselineRecord[];
}

export interface MutationInventoryResult {
  discoveredMutationCount: number;
  mappedMutationCount: number;
  exceptedMutationCount: number;
  unmappedToolNames: string[];
  staleExceptionIds: string[];
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
  if (object['properties'] === undefined) return [];
  const properties = asObject(object['properties'], `${description} properties`);
  return Object.keys(properties).sort(compareText);
}

const DIMENSIONS: readonly SchemaAuditDimension[] = [
  'field',
  'nesting',
  'requiredness',
  'type',
  'enum',
  'nullability',
  'constraint',
  'strictness',
];

function issueHash(dimension: SchemaAuditDimension, detail: string): string {
  return createHash('sha256')
    .update(`${HASH_DOMAIN}/issue\0${dimension}\0${detail}`, 'utf8')
    .digest('hex');
}

function stateHash(
  mappingId: string,
  ignored: string[],
  issuesByDimension: Record<SchemaAuditDimension, string[]>,
): string {
  const canonical = JSON.stringify({
    domain: HASH_DOMAIN,
    mappingId,
    ignored,
    issues: Object.fromEntries(
      DIMENSIONS.map((dimension) => [
        dimension,
        issuesByDimension[dimension]
          .map((detail) => issueHash(dimension, detail))
          .sort(compareText),
      ]),
    ),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function emptyIssues(): Record<SchemaAuditDimension, string[]> {
  return Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, []])) as unknown as Record<
    SchemaAuditDimension,
    string[]
  >;
}

function schemaTypes(schema: JsonObject): Set<string> {
  const result = new Set<string>();
  const type = schema['type'];
  if (typeof type === 'string') result.add(type);
  else if (Array.isArray(type)) {
    for (const value of type) if (typeof value === 'string') result.add(value);
  }
  if (schema['nullable'] === true || (schema['enum'] as unknown[] | undefined)?.includes(null)) {
    result.add('null');
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const alternatives = schema[keyword];
    if (Array.isArray(alternatives)) {
      for (const alternative of alternatives) {
        if (alternative && typeof alternative === 'object' && !Array.isArray(alternative)) {
          for (const value of schemaTypes(alternative as JsonObject)) result.add(value);
        }
      }
    }
  }
  if (result.size === 0) {
    if (schema['properties']) result.add('object');
    else if (schema['items']) result.add('array');
  }
  return result;
}

function normalizedPrimitiveTypes(schema: JsonObject): string[] {
  return [...schemaTypes(schema)]
    .filter((value) => !['null', 'object', 'array'].includes(value))
    .map((value) => (value === 'integer' ? 'number' : value))
    .sort(compareText);
}

function nesting(schema: JsonObject): 'object' | 'array' | 'scalar' {
  const types = schemaTypes(schema);
  if (types.has('object')) return 'object';
  if (types.has('array')) return 'array';
  return 'scalar';
}

function dereferenceSchema(
  schema: unknown,
  schemas: JsonObject,
  seen = new Set<string>(),
): JsonObject {
  const object = asObject(schema, 'Schema node');
  const reference = object['$ref'];
  if (typeof reference === 'string') {
    const prefix = '#/components/schemas/';
    if (!reference.startsWith(prefix))
      throw new Error('External schema references are unsupported');
    const name = decodeURIComponent(reference.slice(prefix.length));
    if (seen.has(name)) return object;
    if (!Object.hasOwn(schemas, name)) throw new Error('Referenced OpenAPI schema not found');
    return dereferenceSchema(schemas[name], schemas, new Set([...seen, name]));
  }
  const allOf = object['allOf'];
  if (!Array.isArray(allOf)) return object;
  const merged: JsonObject = { ...object };
  delete merged['allOf'];
  const properties: JsonObject = { ...(object['properties'] as JsonObject | undefined) };
  const required = new Set(Array.isArray(object['required']) ? object['required'] : []);
  for (const member of allOf) {
    const expanded = dereferenceSchema(member, schemas, seen);
    Object.assign(properties, expanded['properties'] as JsonObject | undefined);
    for (const value of Array.isArray(expanded['required']) ? expanded['required'] : []) {
      if (typeof value === 'string') required.add(value);
    }
    for (const [key, value] of Object.entries(expanded)) {
      if (!['properties', 'required'].includes(key) && merged[key] === undefined)
        merged[key] = value;
    }
  }
  if (Object.keys(properties).length) merged['properties'] = properties;
  if (required.size) merged['required'] = [...required];
  return merged;
}

const CONSTRAINT_KEYS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const;

function canonicalValue(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) => compareText(left, right)),
        )
      : nested,
  );
}

function compareSchemaNodes(
  toolSchema: unknown,
  specificationSchema: unknown,
  schemas: JsonObject,
  ignored: Set<string>,
  exceptionHashes: Set<string>,
): {
  checkedNodeCount: number;
  issues: Record<SchemaAuditDimension, string[]>;
} {
  const issues = emptyIssues();
  let checkedNodeCount = 0;
  const addIssue = (dimension: SchemaAuditDimension, detail: string) => {
    if (!exceptionHashes.has(issueHash(dimension, detail))) issues[dimension].push(detail);
  };

  const visit = (
    toolValue: unknown,
    specValue: unknown,
    path: string,
    requiredBySpec: boolean,
    requiredByTool: boolean,
  ) => {
    const tool = asObject(toolValue, `Tool schema at ${path || '<root>'}`);
    const specification = dereferenceSchema(specValue, schemas);
    checkedNodeCount += 1;

    const specNesting = nesting(specification);
    const toolNesting = nesting(tool);
    if (specNesting !== toolNesting) {
      addIssue('nesting', `${path || '<root>'}:${specNesting}:${toolNesting}`);
      return;
    }
    if (requiredBySpec !== requiredByTool) {
      addIssue('requiredness', `${path || '<root>'}:${requiredBySpec}:${requiredByTool}`);
    }
    const specNullable = schemaTypes(specification).has('null');
    const toolNullable = schemaTypes(tool).has('null');
    if (specNullable !== toolNullable) {
      addIssue('nullability', `${path || '<root>'}:${specNullable}:${toolNullable}`);
    }
    if (specNesting === 'scalar') {
      const expectedTypes = normalizedPrimitiveTypes(specification);
      const actualTypes = normalizedPrimitiveTypes(tool);
      if (canonicalValue(expectedTypes) !== canonicalValue(actualTypes)) {
        addIssue(
          'type',
          `${path || '<root>'}:${canonicalValue(expectedTypes)}:${canonicalValue(actualTypes)}`,
        );
      }
      const expectedEnum = Array.isArray(specification['enum']) ? specification['enum'] : undefined;
      const actualEnum = Array.isArray(tool['enum']) ? tool['enum'] : undefined;
      if (expectedEnum || actualEnum) {
        const expected = [...(expectedEnum ?? [])].sort();
        const actual = [...(actualEnum ?? [])].sort();
        if (canonicalValue(expected) !== canonicalValue(actual)) {
          addIssue(
            'enum',
            `${path || '<root>'}:${canonicalValue(expected)}:${canonicalValue(actual)}`,
          );
        }
      }
    }
    for (const key of CONSTRAINT_KEYS) {
      if (specification[key] !== undefined || tool[key] !== undefined) {
        if (canonicalValue(specification[key]) !== canonicalValue(tool[key])) {
          addIssue(
            'constraint',
            `${path || '<root>'}:${key}:${canonicalValue(specification[key])}:${canonicalValue(tool[key])}`,
          );
        }
      }
    }

    if (specNesting === 'array') {
      if (specification['items'] && tool['items']) {
        visit(tool['items'], specification['items'], `${path}[]`, false, false);
      }
      return;
    }
    if (specNesting !== 'object') return;
    if (tool['additionalProperties'] !== false) {
      addIssue('strictness', `${path || '<root>'}:additionalProperties`);
    }
    const specificationProperties = asObject(
      specification['properties'] ?? {},
      `OpenAPI schema properties at ${path || '<root>'}`,
    );
    const toolProperties = asObject(
      tool['properties'] ?? {},
      `Tool schema properties at ${path || '<root>'}`,
    );
    const requiredSpec = new Set(
      (Array.isArray(specification['required']) ? specification['required'] : []).filter(
        (value): value is string => typeof value === 'string',
      ),
    );
    const requiredTool = new Set(
      (Array.isArray(tool['required']) ? tool['required'] : []).filter(
        (value): value is string => typeof value === 'string',
      ),
    );
    for (const [property, childSpec] of Object.entries(specificationProperties).sort(
      ([left], [right]) => compareText(left, right),
    )) {
      const childPath = path ? `${path}.${property}` : property;
      if (ignored.has(property) || ignored.has(childPath)) continue;
      if (!Object.hasOwn(toolProperties, property)) {
        addIssue('field', childPath);
        continue;
      }
      visit(
        toolProperties[property],
        childSpec,
        childPath,
        requiredSpec.has(property),
        requiredTool.has(property),
      );
    }
  };
  visit(toolSchema, specificationSchema, '', false, false);
  for (const dimension of DIMENSIONS) issues[dimension].sort(compareText);
  return { checkedNodeCount, issues };
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
    const specificationSchema = schemas[mapping.specSchemaName];
    const specification = sortedPropertyNames(
      dereferenceSchema(specificationSchema, schemas),
      `OpenAPI schema for ${mapping.id}`,
    );
    const ignored = [...new Set(mapping.ignoredProperties ?? [])].sort(compareText);
    const exceptionHashes = new Set(
      (mapping.compatibilityExceptions ?? []).map(({ issueHash: identity, rationale }) => {
        if (!identity || !rationale.trim()) {
          throw new Error(`Invalid compatibility exception for mapping ${mapping.id}`);
        }
        return identity;
      }),
    );
    const comparison = compareSchemaNodes(
      toolSchema,
      specificationSchema,
      schemas,
      new Set(ignored),
      exceptionHashes,
    );
    const missing = comparison.issues.field;
    const compatibilityIssueCount = DIMENSIONS.reduce(
      (count, dimension) => count + comparison.issues[dimension].length,
      0,
    );

    return {
      id: mapping.id,
      declaredPropertyCount: declared.length,
      specificationPropertyCount: specification.length,
      ignoredProperties: ignored,
      missingProperties: missing,
      checkedNodeCount: comparison.checkedNodeCount,
      compatibilityIssueCount,
      resultClass: (compatibilityIssueCount === 0 ? 'compatible' : 'tracked-gap') as
        'compatible' | 'tracked-gap',
      issuesByDimension: comparison.issues,
      stateHash: stateHash(mapping.id, ignored, comparison.issues),
    };
  });

  return results.sort((a, b) => compareText(a.id, b.id));
}

export function toAuditBaseline(results: readonly SchemaAuditResult[]): SchemaAuditBaseline {
  return {
    formatVersion: 2,
    records: [...results]
      .sort((a, b) => compareText(a.id, b.id))
      .map((result) => ({
        id: result.id,
        declaredPropertyCount: result.declaredPropertyCount,
        specificationPropertyCount: result.specificationPropertyCount,
        missingPropertyCount: result.missingProperties.length,
        checkedNodeCount: result.checkedNodeCount,
        issuesByDimension: Object.fromEntries(
          DIMENSIONS.map((dimension) => [dimension, result.issuesByDimension[dimension].length]),
        ) as Record<SchemaAuditDimension, number>,
        resultClass: result.compatibilityIssueCount === 0 ? 'compatible' : 'tracked-gap',
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
  const totals = {
    compatible: results.filter(({ resultClass }) => resultClass === 'compatible').length,
    trackedGap: results.filter(({ resultClass }) => resultClass === 'tracked-gap').length,
    nodes: results.reduce((count, result) => count + result.checkedNodeCount, 0),
    issues: results.reduce((count, result) => count + result.compatibilityIssueCount, 0),
  };
  const lines = [
    `Schema audit: ${status} mappings=${results.length} compatible=${totals.compatible} tracked-gap=${totals.trackedGap} nodes=${totals.nodes} issues=${totals.issues} ${DIMENSIONS.map((dimension) => `${dimension}=${results.reduce((count, result) => count + result.issuesByDimension[dimension].length, 0)}`).join(' ')}`,
  ];
  if (comparison && !comparison.matches) {
    lines.push(`Changed mappings: ${comparison.changedMappingIds.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatAuditFields(results: readonly SchemaAuditResult[]): string {
  const lines: string[] = [];
  for (const result of [...results].sort((a, b) => compareText(a.id, b.id))) {
    lines.push(`${result.id}:`);
    // Property names originate in a fetched document. JSON quoting preserves
    // their exact value while preventing terminal control-sequence injection.
    for (const dimension of DIMENSIONS) {
      lines.push(`  ${dimension}:`);
      const issues = result.issuesByDimension[dimension];
      lines.push(...issues.map((issue) => `    - ${JSON.stringify(issue)}`));
      if (issues.length === 0) lines.push('    (none)');
    }
  }
  return `${lines.join('\n')}\n`;
}

export function auditMutationInventory(
  tools: readonly DiscoveredToolSchema[],
  mappings: readonly SchemaAuditMapping[],
  exceptions: readonly MutationAuditException[],
): MutationInventoryResult {
  const mutationTools = tools.filter(({ inputSchema }) => {
    const properties = inputSchema['properties'];
    return (
      properties !== null &&
      typeof properties === 'object' &&
      !Array.isArray(properties) &&
      (Object.hasOwn(properties, 'confirm') || Object.hasOwn(properties, 'dryRun'))
    );
  });
  const discoveredNames = new Set(mutationTools.map(({ name }) => name));
  const mappedNames = new Set(mappings.map(({ toolName }) => toolName));
  const exceptionIds = new Set<string>();
  const exceptionNames = new Set<string>();
  for (const exception of exceptions) {
    if (
      !exception.id ||
      exceptionIds.has(exception.id) ||
      exceptionNames.has(exception.toolName) ||
      !exception.rationale.trim()
    ) {
      throw new Error('Invalid or duplicate mutation-audit exception');
    }
    if (exception.kind === 'passthrough' && !exception.preservationTest?.trim()) {
      throw new Error(`Passthrough exception ${exception.id} requires a preservation test`);
    }
    exceptionIds.add(exception.id);
    exceptionNames.add(exception.toolName);
  }
  const unmappedToolNames = [...discoveredNames]
    .filter((name) => !mappedNames.has(name) && !exceptionNames.has(name))
    .sort(compareText);
  const staleExceptionIds = exceptions
    .filter(({ toolName }) => !discoveredNames.has(toolName))
    .map(({ id }) => id)
    .sort(compareText);
  return {
    discoveredMutationCount: mutationTools.length,
    mappedMutationCount: [...discoveredNames].filter((name) => mappedNames.has(name)).length,
    exceptedMutationCount: [...discoveredNames].filter((name) => exceptionNames.has(name)).length,
    unmappedToolNames,
    staleExceptionIds,
  };
}
