import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdtempSync,
  openSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import {
  accountListColumns,
  voucherAttachmentColumns,
  voucherDetailColumns,
  voucherListColumns,
  voucherRowColumns,
} from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';

/**
 * Write a downloaded file to `target`, refusing to write through a symlink.
 * Mirrors writePdf() in tools/invoices.ts, generalized to an arbitrary
 * buffer/content-type rather than an assumed PDF — voucher attachments can be
 * PDF, JPEG, PNG, etc.
 *
 * These paths come from tool arguments, i.e. they are model-generated and can
 * be influenced by whatever the model just read. O_EXCL already refuses to
 * follow a symlink; O_NOFOLLOW gives the overwrite path the same guarantee,
 * so "replace this file" can never silently truncate a symlink's target
 * instead. O_NOFOLLOW is POSIX-only, so Windows falls back to an explicit
 * lstat check.
 */
function writeBinaryFile(target: string, data: Buffer, overwrite?: boolean): void {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW } = fsConstants;
  const flags = overwrite
    ? O_WRONLY | O_CREAT | O_TRUNC | (O_NOFOLLOW ?? 0)
    : O_WRONLY | O_CREAT | O_EXCL;

  if (overwrite && !O_NOFOLLOW && lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(
      `${target} is a symbolic link. Refusing to write through it — pass the real path instead.`,
    );
  }

  try {
    const fd = openSync(target, flags, 0o600);
    try {
      let written = 0;
      while (written < data.length) {
        written += writeSync(fd, data, written, data.length - written);
      }
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(
        `${target} already exists. Pass a different outputPath, or overwrite: true to replace it.`,
      );
    }
    if (code === 'ELOOP') {
      throw new Error(
        `${target} is a symbolic link. Refusing to write through it — pass the real path instead.`,
      );
    }
    throw err;
  }
}

// The full writable VoucherRow field set (Fortnox `VoucherRowSinglePayloadItem`).
// The MCP SDK strips any key the schema does not declare, so an undeclared field
// reaches neither Fortnox nor an error message — a per-line note passed as
// TransactionInformation simply vanished and the voucher booked without it
// (#101). createVoucher() forwards rows verbatim, so this schema is the only
// place fields were being lost.
const VoucherRowSchema = z.strictObject({
  Account: z.number().describe('Kontonummer'),
  Debit: z.number().optional().describe('Debetbelopp'),
  Credit: z.number().optional().describe('Kreditbelopp'),
  Description: z
    .string()
    .optional()
    .describe(
      'Radbeskrivning. OBS: Fortnox fyller normalt detta fält med kontots egen registrerade benämning, oavsett vad som skickas. Använd TransactionInformation för fritext per rad.',
    ),
  TransactionInformation: z
    .string()
    .optional()
    .describe(
      'Fritext för just denna rad (vem, vad, varför). Detta är det fria textfältet per rad — till skillnad från Description, som normalt speglar kontots egen benämning.',
    ),
  CostCenter: z.string().optional().describe('Kostnadsställe för denna rad'),
  Project: z.string().optional().describe('Projektnummer för denna rad'),
  Quantity: z.number().optional().describe('Antal (används av vissa kontotyper)'),
  Removed: z
    .boolean()
    .optional()
    .describe('Markerar raden som makulerad. Sätts normalt inte vid skapande.'),
});

const VoucherSeriesSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,9}$/, 'Voucher series must be alphanumeric')
  .optional();

export function registerBookkeepingTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const {
    listAccounts,
    listVouchers,
    getVoucher,
    createVoucher,
    attachVoucherFiles,
    listVoucherAttachments,
    getVoucherFile,
    extensionForMime,
  } = operations;
  server.tool(
    'fortnox_list_vouchers',
    'Lista verifikationer i Fortnox. Returnerar: VoucherSeries, VoucherNumber, TransactionDate, Description.',
    {
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      series: z.string().optional().describe('Verifikationsserie (t.ex. "A")'),
      fromDate: z.string().optional().describe('Från datum (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('Till datum (YYYY-MM-DD)'),
      page: z.number().optional().describe('Sidnummer'),
      limit: z.number().optional().describe('Antal per sida'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ financialYear, series, fromDate, toDate, page, limit, all, includeRaw }) => {
      const data = await listVouchers({
        financialYear,
        series,
        fromDate,
        toDate,
        page,
        limit,
        all,
      });
      return listResponse(
        data.Vouchers ?? [],
        voucherListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_voucher',
    'Hämta en enskild verifikation med rader från Fortnox. Returnerar: VoucherSeries, VoucherNumber, TransactionDate, Description, samt VoucherRows med Account, Debit, Credit. Makulerade rader (Removed) märks med [REMOVED] och ska inte räknas med — de är ersatta av en annan rad i samma verifikation.',
    {
      series: z.string().describe('Verifikationsserie (t.ex. "A")'),
      voucherNumber: z.string().describe('Verifikationsnummer'),
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ series, voucherNumber, financialYear, includeRaw }) => {
      const data = await getVoucher(series, voucherNumber, financialYear);
      const rows = (data.VoucherRows as Record<string, unknown>[]) ?? [];
      const header = detailResponse(data, voucherDetailColumns, data, false);
      const rowTable = listResponse(rows, voucherRowColumns, data, undefined, includeRaw);
      const headerText = (header.content as { type: string; text: string }[])[0].text;
      const rowText = (rowTable.content as { type: string; text: string }[])[0].text;
      return { content: [{ type: 'text' as const, text: `${headerText}\n\nRows:\n${rowText}` }] };
    },
  );

  server.tool(
    'fortnox_create_voucher',
    'Skapa en verifikation i Fortnox',
    {
      Description: z.string().describe('Beskrivning av verifikationen'),
      VoucherSeries: VoucherSeriesSchema.describe('Verifikationsserie (default: "A")'),
      TransactionDate: z.string().describe('Transaktionsdatum (YYYY-MM-DD)'),
      VoucherRows: z.array(VoucherRowSchema).describe('Verifikationsrader (debet och kredit)'),
      confirm: z.boolean().optional().describe('Bekräfta att verifikationen ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa verifikationen'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create voucher "${params.Description}"`, { Voucher: params });
      }
      if (!confirm) requireConfirmation(`create voucher "${params.Description}"`);

      const data = await createVoucher(params);
      return detailResponse(data, voucherDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_list_accounts',
    'Visa kontoplan i Fortnox. Returnerar: Number, Description, SRU.',
    {
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      search: z.string().optional().describe('Sök på kontonamn'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ includeRaw, ...params }) => {
      const data = await listAccounts(params);
      return listResponse(
        data.Accounts ?? [],
        accountListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_attach_voucher_files',
    'Ladda upp kvitto/underlagsfiler och koppla dem till en verifikation i Fortnox',
    {
      series: z.string().describe('Verifikationsserie (t.ex. "A")'),
      voucherNumber: z.string().describe('Verifikationsnummer'),
      files: z.array(z.string()).describe('Sökvägar till filer som ska laddas upp och kopplas'),
      year: z
        .number()
        .optional()
        .describe('Räkenskapsår (härleds från verifikationsdatum om utelämnat)'),
      confirm: z.boolean().optional().describe('Bekräfta att filerna ska kopplas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att ladda upp filerna'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ series, voucherNumber, files, year, confirm, dryRun, includeRaw }) => {
      if (dryRun) {
        return dryRunResponse(
          `attach ${files.length} file(s) to voucher ${series}/${voucherNumber}`,
          {
            series,
            voucherNumber,
            files,
            year,
          },
        );
      }
      if (!confirm) {
        requireConfirmation(`attach ${files.length} file(s) to voucher ${series}/${voucherNumber}`);
      }
      const results = await attachVoucherFiles({
        series,
        voucherNumber,
        filePaths: files,
        financialYear: year,
      });
      const ids = results.map((r) => r.fileId).join(', ');
      const summary = `Kopplade ${results.length} fil(er) till verifikation ${series}/${voucherNumber}. Fil-ID: ${ids}`;
      return textResponse(
        includeRaw ? `${summary}\n\n${JSON.stringify(results, null, 2)}` : summary,
      );
    },
  );

  server.tool(
    'fortnox_list_voucher_attachments',
    'Lista filer (kvitton/underlag) som är kopplade till en verifikation i Fortnox. Returnerar: File (filnamn), File ID, Year. Använd fileId med fortnox_get_voucher_file för att hämta själva filen.',
    {
      series: z.string().describe('Verifikationsserie (t.ex. "A")'),
      voucherNumber: z.string().describe('Verifikationsnummer'),
      financialYear: z
        .number()
        .optional()
        .describe(
          'Räkenskapsår. Rekommenderas — verifikationsnummer återanvänds mellan räkenskapsår, så serie+nummer ensamt kan vara tvetydigt.',
        ),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ series, voucherNumber, financialYear, includeRaw }) => {
      const attachments = await listVoucherAttachments(series, voucherNumber, financialYear);
      return listResponse(
        attachments as unknown as Record<string, unknown>[],
        voucherAttachmentColumns,
        attachments,
        undefined,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_voucher_file',
    'Ladda ner en fil som är kopplad till en verifikation och spara den på disk. Returnerar sökvägen till filen (inte filinnehållet). Hämta fileId via fortnox_list_voucher_attachments.',
    {
      fileId: z.string().describe('Fil-ID, från fortnox_list_voucher_attachments'),
      outputPath: z
        .string()
        .optional()
        .describe(
          'Sökväg att spara filen till. Skriver inte över en befintlig fil om inte overwrite är satt. Utelämnas: en ny privat temp-katalog används.',
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe('Tillåt att en befintlig fil på outputPath skrivs över'),
    },
    async ({ fileId, outputPath, overwrite }) => {
      const file = await getVoucherFile(fileId);
      const ext = extensionForMime(file.contentType);
      const target = outputPath
        ? resolve(outputPath)
        : join(mkdtempSync(join(tmpdir(), 'noxctl-')), `voucher-file-${fileId}${ext}`);
      writeBinaryFile(target, file.buffer, overwrite);
      return textResponse(
        `Sparade fil (${file.contentType}, ${file.buffer.length} bytes) till ${target}`,
      );
    },
  );
}
