import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './version.js';
import { getStrictToolInventory, type StrictToolInventoryEntry } from './strict-mcp-server.js';

export const CAPABILITY_RESOURCE_URI = 'noxctl://capabilities';

const mutationControls = new Set(['confirm', 'dryRun']);

function toolSummary(tool: StrictToolInventoryEntry) {
  const mutation = tool.inputFields.some((field) => mutationControls.has(field));
  const isPdf = tool.name.endsWith('_pdf');
  return {
    name: tool.name,
    description: tool.description,
    access: mutation ? 'potential-mutation' : 'read',
    ...(isPdf
      ? {
          note: 'Previewläget är läsning; utskrift eller sparande kan kräva bekräftelse.',
        }
      : {}),
  } as const;
}

export function registerCapabilityResource(server: McpServer): void {
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
      const document = {
        name: 'fortnox-mcp',
        version: VERSION,
        description:
          'Svensk MCP-server för läsning och arbetsflöden i Fortnox. Verktygen följer den aktuella serverns anslutning.',
        inventoryNote:
          'Detta är serverns registrerade verktygsinventering. Den beskriver inte kontoåtkomst, Fortnox-behörigheter eller licenser.',
        tools,
        workflows: {
          readOnly:
            'Läsverktyg ändrar inte Fortnox-data. Lokala diagnostikverktyg kan även kontrollera profil och anslutning.',
          mutations: {
            confirmation: 'Skrivande verktyg kräver confirm: true innan de ändrar Fortnox-data.',
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
