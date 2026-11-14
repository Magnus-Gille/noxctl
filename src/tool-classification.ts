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

// MCP: destructiveHint false means the tool only performs additive updates. A
// delete or cancel removes data, and an update, patch or replace overwrites
// existing values (a JSON Patch can also remove them), so all of these are
// destructive. Only creates and state-advancing calls are additive.
const DESTRUCTIVE_NAME_PATTERN = /^fortnox_(delete|cancel|update|patch|replace)_/;

// Irreversible or overwriting tools that the name pattern does not cover.
// Adding a tool here (or a delete/cancel name) must be a conscious decision;
// tests/mcp-tool-annotations.test.ts pins the exact set.
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'fortnox_credit_invoice', // closes the invoice with a credit note
  'fortnox_credit_supplier_invoice', // closes the supplier invoice with a credit note
  'fortnox_detach_document_attachment', // removes the link, like the delete_*_file_connection tools
  'fortnox_finish_contract', // ends the contract; no further invoices are created
  'fortnox_reset_scheduletime_day', // overwrites and resets one schedule day
  'fortnox_send_invoice', // overwrites stored EmailSubject/EmailBody/EmailAddressBCC before sending
]);

// An `overwrite` control lets a tool truncate an existing local file. That is
// destructive even for a tool whose Fortnox effect is additive (for example the
// PDF tools, which keep confirm/dryRun for markSent but can also save to disk).
const LOCAL_OVERWRITE_FIELDS: ReadonlySet<string> = new Set(['overwrite']);

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
      destructiveHint:
        DESTRUCTIVE_NAME_PATTERN.test(name) ||
        DESTRUCTIVE_TOOLS.has(name) ||
        inputFields.some((field) => LOCAL_OVERWRITE_FIELDS.has(field)),
      idempotentHint: IDEMPOTENT_NAME_PATTERN.test(name),
      openWorldHint,
    },
  };
}
