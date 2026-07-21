import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsAvailable, setupLiveClientServer, getText } from './setup.js';

let hasCredentials = false;

beforeAll(async () => {
  hasCredentials = await credentialsAvailable();
});

describe('live: fortnox_list_invoices', () => {
  it('returns a list of invoices from the real API', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live invoice tests.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_invoices',
      arguments: { limit: 5 },
    });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
    // Tool renders a table with columns Doc #, Customer, Date, Due, Total, Balance
    // or a message saying there are no results
    expect(text).toMatch(/Doc\s*#|Customer|Total|Balance|No results/i);
  });

  it('filters invoices by unpaid status', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live filter test.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_invoices',
      arguments: { filter: 'unpaid', limit: 5 },
    });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it('filters invoices by date range', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live date filter test.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_invoices',
      arguments: { fromDate: '2024-01-01', toDate: '2024-12-31', limit: 5 },
    });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('live: fortnox_invoice_pdf', () => {
  it('downloads a real PDF without changing the invoice', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live invoice PDF test.');
      return;
    }

    const { client } = await setupLiveClientServer();

    // Pick a real invoice from the account rather than hardcoding a number.
    const list = await client.callTool({
      name: 'fortnox_list_invoices',
      arguments: { limit: 1, includeRaw: true },
    });
    const raw = getText(list).split('Raw JSON:\n')[1];
    if (!raw) {
      console.log('SKIP: No invoices in this account — skipping live invoice PDF test.');
      return;
    }
    const invoices = (
      JSON.parse(raw) as { Invoices?: { DocumentNumber: string; Sent?: boolean }[] }
    ).Invoices;
    if (!invoices?.length) {
      console.log('SKIP: No invoices in this account — skipping live invoice PDF test.');
      return;
    }
    const { DocumentNumber, Sent: sentBefore } = invoices[0]!;

    const target = join(tmpdir(), `noxctl-live-invoice-${DocumentNumber}.pdf`);
    try {
      const result = await client.callTool({
        name: 'fortnox_invoice_pdf',
        arguments: { documentNumber: DocumentNumber, outputPath: target },
      });

      expect(result.isError).toBeFalsy();

      // A real PDF, not an error envelope that merely got saved with a .pdf name.
      const bytes = readFileSync(target);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(bytes.length).toBeGreaterThan(1000);

      // The default /preview path must leave the invoice's Sent flag alone.
      const after = await client.callTool({
        name: 'fortnox_get_invoice',
        arguments: { documentNumber: DocumentNumber, includeRaw: true },
      });
      const afterRaw = getText(after).split('Raw JSON:\n')[1];
      const sentAfter = (JSON.parse(afterRaw!) as { Sent?: boolean }).Sent;
      expect(sentAfter).toBe(sentBefore);
    } finally {
      rmSync(target, { force: true });
    }
  });
});
