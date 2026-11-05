import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OperationObserver } from '../shadow/types.js';
import { textResponse } from '../tool-output.js';

/** Optional host-bound status surface; it accepts no company or queue selectors. */
export function registerShadowStatusTool(server: McpServer, observer: OperationObserver): void {
  server.tool(
    'fortnox_shadow_status',
    'Visar status för den värdhanterade skuggkörningen i den här tenantbundna sessionen.',
    {},
    async () => textResponse(JSON.stringify(observer.status(), null, 2)),
  );
}
