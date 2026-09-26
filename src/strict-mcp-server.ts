import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

type ToolShape = Record<string, z.ZodType>;

export interface StrictToolInventoryEntry {
  name: string;
  description: string;
  inputFields: readonly string[];
}

const toolInventories = new WeakMap<McpServer, StrictToolInventoryEntry[]>();

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
 */
export function createStrictMcpServer(serverInfo: Implementation): McpServer {
  const server = new McpServer(serverInfo);
  const inventory: StrictToolInventoryEntry[] = [];
  toolInventories.set(server, inventory);

  server.tool = ((name: string, description: string, shape: ToolShape, callback: unknown) => {
    if (typeof description !== 'string' || !isToolShape(shape) || typeof callback !== 'function') {
      throw new Error(
        `Tool ${name} must use tool(name, description, ZodRawShape, callback) so input strictness is explicit.`,
      );
    }

    const inputSchema = z.strictObject(shape);
    const registeredTool = server.registerTool(
      name,
      { description, inputSchema },
      callback as ToolCallback<typeof inputSchema>,
    ) as RegisteredTool;
    inventory.push({ name, description, inputFields: Object.keys(shape) });
    return registeredTool;
  }) as McpServer['tool'];

  return server;
}

/** Return the tool inventory captured at the repository's strict registration boundary. */
export function getStrictToolInventory(server: McpServer): readonly StrictToolInventoryEntry[] {
  return toolInventories.get(server) ?? [];
}
