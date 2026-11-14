import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createFortnoxClient } from '../src/fortnox-client.js';
import { createServer, type OperationObserver } from '../src/index.js';

// Every destructive tool must be a conscious decision: adding a delete-like
// tool without listing it here fails the exact-set assertion below.
const EXPECTED_DESTRUCTIVE_TOOLS = [
  'fortnox_cancel_invoice',
  'fortnox_cancel_offer',
  'fortnox_cancel_order',
  'fortnox_cancel_supplier_invoice',
  'fortnox_credit_invoice',
  'fortnox_credit_supplier_invoice',
  'fortnox_delete_absencetransaction',
  'fortnox_delete_account',
  'fortnox_delete_archive_entry',
  'fortnox_delete_archive_path',
  'fortnox_delete_article',
  'fortnox_delete_attendancetransaction',
  'fortnox_delete_contract_accrual',
  'fortnox_delete_costcenter',
  'fortnox_delete_customer',
  'fortnox_delete_inbox_entry',
  'fortnox_delete_invoice_accrual',
  'fortnox_delete_invoice_payment',
  'fortnox_delete_price',
  'fortnox_delete_project',
  'fortnox_delete_salarytransaction',
  'fortnox_delete_supplier_invoice_accrual',
  'fortnox_delete_supplier_invoice_file_connection',
  'fortnox_delete_supplier_invoice_payment',
  'fortnox_delete_taxreduction',
  'fortnox_delete_voucher_file_connection',
  'fortnox_detach_document_attachment',
  'fortnox_finish_contract',
  'fortnox_get_archive_entry', // saves to a local path and can overwrite
  'fortnox_get_inbox_file', // saves to a local path and can overwrite
  'fortnox_get_supplier_invoice_file', // saves to a local path and can overwrite
  'fortnox_get_voucher_file', // saves to a local path and can overwrite
  'fortnox_replace_recurring',
  'fortnox_reset_scheduletime_day',
];

const LOCAL_ONLY_TOOLS = ['fortnox_shadow_status'];

// Read-only mode trusts the structural rule (no confirm/dryRun input = read).
// Any registered tool that is classified as a read but whose name is not
// get_*/list_* must be listed here on purpose, so a new write tool that forgot
// its confirmation controls cannot silently appear in a read-only server.
const EXPECTED_NON_GET_LIST_READ_TOOLS = [
  'fortnox_balance_sheet',
  'fortnox_company_info',
  'fortnox_general_ledger',
  'fortnox_income_statement',
  'fortnox_overdue_invoices',
  'fortnox_preflight_invoice',
  'fortnox_status',
  'fortnox_tax_report',
  'fortnox_top_customers',
  'fortnox_unpaid_totals',
  'fortnox_vat_summary',
];

async function listAnnotatedTools(server: McpServer = createServer()) {
  const client = new Client({ name: 'annotation-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
  }
}

describe('MCP tool annotations', () => {
  it('gives every tool boolean readOnlyHint and openWorldHint', async () => {
    const tools = await listAnnotatedTools();
    expect(tools.length).toBeGreaterThan(200);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe('boolean');
    }
  });

  it('marks exactly the tools with confirm, dryRun or outputPath inputs as not read-only', async () => {
    const tools = await listAnnotatedTools();
    for (const tool of tools) {
      const fields = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      const mutation =
        fields.includes('confirm') || fields.includes('dryRun') || fields.includes('outputPath');
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!mutation);
      if (mutation) {
        expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
      } else {
        expect(tool.annotations?.destructiveHint, tool.name).toBeUndefined();
        expect(tool.annotations?.idempotentHint, tool.name).toBeUndefined();
      }
    }
  });

  it('classifies as reads only get/list tools and an explicit allowlist of reports', async () => {
    const tools = await listAnnotatedTools();
    const reads = tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name);
    const unusual = reads.filter((name) => !/^fortnox_(get|list)_/.test(name)).sort();
    expect(unusual).toEqual([...EXPECTED_NON_GET_LIST_READ_TOOLS].sort());
    // A read tool must not be able to choose a local output path.
    for (const tool of tools.filter((t) => t.annotations?.readOnlyHint === true)) {
      const fields = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(fields, tool.name).not.toContain('outputPath');
    }
    // Verbs that change Fortnox data must never be classified as reads.
    for (const name of reads) {
      expect(name, name).not.toMatch(
        /^fortnox_(create|update|patch|replace|delete|cancel|credit|send|bookkeep|approve|attach|detach|upload|email|eprint|finish|reset|increase|validate)_/,
      );
    }
  });

  it('marks exactly the expected tools as destructive', async () => {
    const tools = await listAnnotatedTools();
    const destructive = tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(destructive).toEqual([...EXPECTED_DESTRUCTIVE_TOOLS].sort());
  });

  it('marks update, patch and replace mutations idempotent and other mutations not', async () => {
    const tools = await listAnnotatedTools();
    for (const tool of tools) {
      if (tool.annotations?.readOnlyHint !== false) continue;
      const idempotent = /^fortnox_(update|patch|replace)_/.test(tool.name);
      expect(tool.annotations?.idempotentHint, tool.name).toBe(idempotent);
    }
  });

  it('marks only purely local tools as closed-world', async () => {
    // The status tool is host-only: fortnox_shadow_status is registered only with
    // a host observer, so the observer-bound server is where it appears.
    const observed = createServer({
      transport: createFortnoxClient({ getAccessToken: vi.fn(), fetch: vi.fn() }),
      observer: { status: () => ({}) } as unknown as OperationObserver,
    });
    const tools = await listAnnotatedTools(observed);
    const closedWorld = tools
      .filter((tool) => tool.annotations?.openWorldHint === false)
      .map((tool) => tool.name);
    expect(closedWorld).toEqual(LOCAL_ONLY_TOOLS);
    expect(
      (await listAnnotatedTools()).filter((t) => t.annotations?.openWorldHint === false),
    ).toEqual([]);
  });
});
