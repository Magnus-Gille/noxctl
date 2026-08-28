/**
 * Supported API for hosts that bind one authorized Fortnox transport context
 * before exposing MCP tools. Model-controlled tool arguments cannot select it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FortnoxTransport } from './fortnox-client.js';
import { createServer as createLocalServer } from './index.js';

export {
  createFortnoxClient,
  FortnoxApiError,
  FortnoxRequestTimeoutError,
  type CreateFortnoxClientOptions,
  type FortnoxRateLimitOptions,
  type FortnoxResponse,
  type FortnoxTransport,
  type RequestOptions,
} from './fortnox-client.js';
export { createFortnoxOperations, type FortnoxOperations } from './operations/index.js';

export interface CreateServerOptions {
  /** Host-authorized transport for exactly one tenant context. */
  transport: FortnoxTransport;
}

/** Create an MCP server that fails closed unless one tenant transport is bound. */
export function createServer(options: CreateServerOptions): McpServer {
  if (!options?.transport) {
    throw new Error('The embedded MCP server requires a tenant-bound transport.');
  }
  return createLocalServer({ transport: options.transport });
}
