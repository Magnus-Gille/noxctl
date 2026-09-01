import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { privateOutputPath, writeBinaryFile } from '../safe-file-output.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';
import { referenceDataColumns } from '../views.js';

function folderItems(raw: Record<string, unknown>): Record<string, unknown>[] {
  const folder = (raw.Folder ?? {}) as Record<string, unknown>;
  return [
    ...((folder.Folders ?? []) as Record<string, unknown>[]),
    ...((folder.Files ?? []) as Record<string, unknown>[]),
  ];
}

export function registerFileTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const {
    listArchive,
    getArchiveEntry,
    uploadArchiveFile,
    deleteArchivePath,
    deleteArchiveEntry,
    listInbox,
    uploadInboxEntry,
    getInboxFile,
    deleteInboxEntry,
  } = operations;

  server.tool(
    'fortnox_list_archive',
    'Lista mappar och filer i Fortnox arkiv',
    {
      path: z.string().optional().describe('Arkivsökväg'),
      fileId: z.string().optional().describe('Valfritt fil-ID'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ path, fileId, includeRaw }) => {
      const raw = await listArchive({ path, fileId });
      return listResponse(folderItems(raw), referenceDataColumns, raw, undefined, includeRaw);
    },
  );

  server.tool(
    'fortnox_get_archive_entry',
    'Ladda ner en fil från Fortnox arkiv till en säker lokal sökväg',
    {
      id: z.string().describe('Arkivpostens ID'),
      path: z.string().optional().describe('Arkivsökväg'),
      fileId: z.string().optional().describe('Valfritt fil-ID'),
      outputPath: z.string().optional().describe('Målsökväg; utelämna för privat tempkatalog'),
      overwrite: z.boolean().optional().describe('Tillåt överskrivning av vanlig fil'),
    },
    async ({ id, path, fileId, outputPath, overwrite }) => {
      const file = await getArchiveEntry(id, { path, fileId });
      const target = writeBinaryFile(
        outputPath ?? privateOutputPath('noxctl-', `archive-${id}`),
        file.buffer,
        overwrite,
      );
      return textResponse(`Archive file ${id} saved to ${target} (${file.buffer.length} bytes).`);
    },
  );

  server.tool(
    'fortnox_upload_archive_file',
    'Ladda upp en lokal fil till Fortnox arkiv',
    {
      filePath: z.string().describe('Lokal filsökväg'),
      folderId: z.string().optional().describe('Målmappens ID'),
      path: z.string().optional().describe('Målsökväg i arkivet'),
      confirm: z.boolean().optional().describe('Bekräfta uppladdningen'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att läsa eller ladda upp filen'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ filePath, folderId, path, confirm, dryRun, includeRaw }) => {
      const target = `upload ${filePath} to archive`;
      if (dryRun) return dryRunResponse(target, { folderId, path });
      if (!confirm) requireConfirmation(target);
      const raw = await uploadArchiveFile(filePath, { folderId, path });
      return detailResponse(
        (raw.File ?? raw) as Record<string, unknown>,
        referenceDataColumns,
        raw,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_delete_archive_path',
    'Ta bort en sökväg i Fortnox arkiv',
    {
      path: z.string().min(1).describe('Exakt arkivsökväg att ta bort'),
      confirm: z.boolean().optional().describe('Bekräfta borttagningen'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att ta bort'),
    },
    async ({ path, confirm, dryRun }) => {
      const target = `delete archive path ${JSON.stringify(path)}`;
      if (dryRun) return dryRunResponse(target);
      if (!confirm) requireConfirmation(target);
      await deleteArchivePath(path);
      return textResponse(`Archive path ${JSON.stringify(path)} deleted.`);
    },
  );

  server.tool(
    'fortnox_delete_archive_entry',
    'Ta bort en post i Fortnox arkiv',
    {
      id: z.string().describe('Arkivpostens ID'),
      path: z.string().optional().describe('Arkivsökväg'),
      confirm: z.boolean().optional().describe('Bekräfta borttagningen'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att ta bort'),
    },
    async ({ id, path, confirm, dryRun }) => {
      const target = `delete archive entry ${id}`;
      if (dryRun) return dryRunResponse(target, { path });
      if (!confirm) requireConfirmation(target);
      await deleteArchiveEntry(id, path);
      return textResponse(`Archive entry ${id} deleted.`);
    },
  );

  server.tool(
    'fortnox_list_inbox',
    'Lista mappar och filer i Fortnox inkorg',
    { includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox') },
    async ({ includeRaw }) => {
      const raw = await listInbox();
      return listResponse(folderItems(raw), referenceDataColumns, raw, undefined, includeRaw);
    },
  );

  server.tool(
    'fortnox_upload_inbox_file',
    'Ladda upp en lokal fil till Fortnox inkorg',
    {
      filePath: z.string().describe('Lokal filsökväg'),
      folderId: z.string().optional().describe('Målmappens ID'),
      path: z.string().optional().describe('Målsökväg i inkorgen'),
      confirm: z.boolean().optional().describe('Bekräfta uppladdningen'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att läsa eller ladda upp filen'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ filePath, folderId, path, confirm, dryRun, includeRaw }) => {
      const target = `upload ${filePath} to inbox`;
      if (dryRun) return dryRunResponse(target, { folderId, path });
      if (!confirm) requireConfirmation(target);
      const raw = await uploadInboxEntry(filePath, { folderId, path });
      return detailResponse(
        (raw.File ?? raw) as Record<string, unknown>,
        referenceDataColumns,
        raw,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_inbox_file',
    'Ladda ner en fil från Fortnox inkorg till en säker lokal sökväg',
    {
      id: z.string().describe('Fil-ID'),
      outputPath: z.string().optional().describe('Målsökväg; utelämna för privat tempkatalog'),
      overwrite: z.boolean().optional().describe('Tillåt överskrivning av vanlig fil'),
    },
    async ({ id, outputPath, overwrite }) => {
      const file = await getInboxFile(id);
      const target = writeBinaryFile(
        outputPath ?? privateOutputPath('noxctl-', `inbox-${id}`),
        file.buffer,
        overwrite,
      );
      return textResponse(`Inbox file ${id} saved to ${target} (${file.buffer.length} bytes).`);
    },
  );

  server.tool(
    'fortnox_delete_inbox_entry',
    'Ta bort en fil eller post från Fortnox inkorg',
    {
      id: z.string().describe('Postens ID'),
      confirm: z.boolean().optional().describe('Bekräfta borttagningen'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att ta bort'),
    },
    async ({ id, confirm, dryRun }) => {
      const target = `delete inbox entry ${id}`;
      if (dryRun) return dryRunResponse(target);
      if (!confirm) requireConfirmation(target);
      await deleteInboxEntry(id);
      return textResponse(`Inbox entry ${id} deleted.`);
    },
  );
}
