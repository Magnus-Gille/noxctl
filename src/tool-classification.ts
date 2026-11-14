import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * Single source of truth for whether a tool can change Fortnox data or the
 * local machine. The
 * capability resource and the MCP annotations both read from here, so they
 * cannot disagree about which tools are mutations.
 */
export type ToolAccess = 'read' | 'potential-mutation' | 'local-write';

export interface ToolClassification {
  access: ToolAccess;
  annotations: ToolAnnotations;
}

// A tool is a potential mutation when its input exposes a confirmation or
// dry-run control. This also catches read modes with an optional mutation flag
// (for example fortnox_invoice_pdf with markSent).
const MUTATION_CONTROLS: ReadonlySet<string> = new Set(['confirm', 'dryRun']);

// A read tool that can choose where to save a file writes to the local
// filesystem (and can overwrite an existing file with `overwrite`). It does not
// change Fortnox data, but it is not read-only either, so it never gets
// readOnlyHint and a read-only server does not register it.
const LOCAL_WRITE_FIELDS: ReadonlySet<string> = new Set(['outputPath']);

const DESTRUCTIVE_NAME_PATTERN = /^fortnox_(delete|cancel)_/;

// Irreversible or overwriting tools that are not covered by the name pattern.
// Adding a tool here (or a delete/cancel name) must be a conscious decision;
// tests/mcp-tool-annotations.test.ts pins the exact set.
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'fortnox_credit_invoice', // closes the invoice with a credit note
  'fortnox_credit_supplier_invoice', // closes the supplier invoice with a credit note
  'fortnox_detach_document_attachment', // removes the link, like the delete_*_file_connection tools
  'fortnox_finish_contract', // ends the contract; no further invoices are created
  'fortnox_replace_recurring', // overwrites the whole recurring definition
  'fortnox_reset_scheduletime_day', // overwrites and resets one schedule day
]);

const IDEMPOTENT_NAME_PATTERN = /^fortnox_(update|patch|replace)_/;

// Tools that do not contact Fortnox at all.
const LOCAL_ONLY_TOOLS: ReadonlySet<string> = new Set(['fortnox_shadow_status']);

/** Classify a registered tool from its name and top-level input field names. */
export function classifyTool(name: string, inputFields: readonly string[]): ToolClassification {
  const openWorldHint = !LOCAL_ONLY_TOOLS.has(name);
  const mutatesFortnox = inputFields.some((field) => MUTATION_CONTROLS.has(field));
  if (!mutatesFortnox && inputFields.some((field) => LOCAL_WRITE_FIELDS.has(field))) {
    return {
      access: 'local-write',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true, // may overwrite an existing file
        idempotentHint: false,
        openWorldHint,
      },
    };
  }
  if (!mutatesFortnox) {
    return { access: 'read', annotations: { readOnlyHint: true, openWorldHint } };
  }
  return {
    access: 'potential-mutation',
    annotations: {
      readOnlyHint: false,
      destructiveHint: DESTRUCTIVE_NAME_PATTERN.test(name) || DESTRUCTIVE_TOOLS.has(name),
      idempotentHint: IDEMPOTENT_NAME_PATTERN.test(name),
      openWorldHint,
    },
  };
}
