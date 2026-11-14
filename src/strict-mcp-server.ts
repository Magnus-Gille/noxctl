import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { classifyTool } from './tool-classification.js';

type ToolShape = Record<string, z.ZodType>;

export interface StrictMcpServerOptions {
  /** Register only tools that cannot change Fortnox data. */
  readOnly?: boolean;
}

export interface StrictToolInventoryEntry {
  name: string;
  description: string;
  inputFields: readonly string[];
}

const toolInventories = new WeakMap<McpServer, StrictToolInventoryEntry[]>();
const toolSchemas = new WeakMap<McpServer, Map<string, z.ZodType>>();

function isToolShape(value: unknown): value is ToolShape {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (field) =>
      typeof field === 'object' &&
      field !== null &&
      'safeParse' in field &&
      typeof field.safeParse === 'function',
  );
}

/**
 * Create the repository's MCP server with fail-closed top-level tool inputs.
 *
 * Tool modules still use the SDK's legacy `tool(name, description, shape,
 * callback)` registration form. The SDK normally turns that raw shape into a
 * stripping Zod object, so misspelled or unsupported keys disappear before the
 * callback sees them. This compatibility boundary preserves the existing tool
 * modules while registering the same shapes as strict objects instead.
 *
 * The narrow overload is deliberate: every noxctl tool follows this convention,
 * and a future registration style must choose its object policy explicitly
 * rather than silently falling back to the SDK default.
 *
 * Every tool also gets MCP annotations from the shared classification module.
 * In read-only mode, tools that can change Fortnox data or write local files
 * are not registered at all, so they are absent from the server, the inventory,
 * and the capabilities.
 */
export function createStrictMcpServer(
  serverInfo: Implementation,
  options: StrictMcpServerOptions = {},
): McpServer {
  const readOnly = options.readOnly === true;
  const server = new McpServer(serverInfo);
  const inventory: StrictToolInventoryEntry[] = [];
  toolInventories.set(server, inventory);
  const schemas = new Map<string, z.ZodType>();
  toolSchemas.set(server, schemas);

  server.tool = ((name: string, description: string, shape: ToolShape, callback: unknown) => {
    if (typeof description !== 'string' || !isToolShape(shape) || typeof callback !== 'function') {
      throw new Error(
        `Tool ${name} must use tool(name, description, ZodRawShape, callback) so input strictness is explicit.`,
      );
    }

    const classification = classifyTool(name, Object.keys(shape));
    if (readOnly && classification.access !== 'read') return undefined;

    const inputSchema = z.strictObject(shape);
    const registeredTool = server.registerTool(
      name,
      { description, inputSchema, annotations: classification.annotations },
      callback as ToolCallback<typeof inputSchema>,
    ) as RegisteredTool;
    inventory.push({ name, description, inputFields: Object.keys(shape) });
    schemas.set(name, inputSchema);
    return registeredTool;
  }) as McpServer['tool'];

  return server;
}

/** Return the tool inventory captured at the repository's strict registration boundary. */
export function getStrictToolInventory(server: McpServer): readonly StrictToolInventoryEntry[] {
  return toolInventories.get(server) ?? [];
}

/** Parse the actual registered schema without invoking any business callback. */
export function parseStrictToolInput(
  server: McpServer,
  name: string,
  input: unknown,
): Record<string, unknown> {
  const schema = toolSchemas.get(server)?.get(name);
  if (!schema) throw new Error('No registered strict input schema for tool');
  return schema.parse(input) as Record<string, unknown>;
}
