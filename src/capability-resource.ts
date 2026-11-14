import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './version.js';
import { getStrictToolInventory, type StrictToolInventoryEntry } from './strict-mcp-server.js';
import { classifyTool } from './tool-classification.js';

export const CAPABILITY_RESOURCE_URI = 'noxctl://capabilities';

export interface CapabilityResourceOptions {
  /** Describe a server that registers only tools which cannot change Fortnox data. */
  readOnly?: boolean;
}

function toolSummary(tool: StrictToolInventoryEntry) {
  const isPdf = tool.name.endsWith('_pdf');
  return {
    name: tool.name,
    description: tool.description,
    access: classifyTool(tool.name, tool.inputFields).access,
    ...(isPdf
      ? {
          note: 'Previewläget är läsning; utskrift eller sparande kan kräva bekräftelse.',
        }
      : {}),
  } as const;
}

export function registerCapabilityResource(
  server: McpServer,
  options: CapabilityResourceOptions = {},
): void {
  server.registerResource(
    'noxctl-capabilities',
    CAPABILITY_RESOURCE_URI,
    {
      title: 'noxctl capabilities',
      description:
        'Svensk kapabilitetsbeskrivning för noxctl: version, verktyg och arbetsflödesgränser.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const tools = getStrictToolInventory(server).map(toolSummary);
      const readOnly = options.readOnly === true;
      const document = {
        name: 'fortnox-mcp',
        version: VERSION,
        mode: readOnly ? 'read-only' : 'full',
        description:
          'Svensk MCP-server för läsning och arbetsflöden i Fortnox. Verktygen följer den aktuella serverns anslutning.',
        inventoryNote:
          'Detta är serverns registrerade verktygsinventering. Den beskriver inte kontoåtkomst, Fortnox-behörigheter eller licenser.',
        tools,
        workflows: {
          readOnly:
            'Läsverktyg ändrar inte Fortnox-data. Lokala diagnostikverktyg kan även kontrollera profil och anslutning.',
          mutations: readOnly
            ? {
                confirmation:
                  'Servern körs i skrivskyddat läge. Skrivande verktyg är inte registrerade och kan inte anropas.',
                dryRun:
                  'Skrivskyddat läge innehåller inga skrivande verktyg, så dryRun finns inte här.',
              }
            : {
                confirmation:
                  'Skrivande verktyg kräver confirm: true innan de ändrar Fortnox-data.',
                dryRun:
                  'Skrivande verktyg stöder dryRun: true för att visa åtgärden utan att utföra den.',
              },
        },
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(document, null, 2),
          },
        ],
      };
    },
  );
}
