import { describe, expect, it } from 'vitest';
import { classifyTool } from '../src/tool-classification.js';
import { InvalidReadOnlyEnvError, parseReadOnlyEnv, READ_ONLY_ENV } from '../src/read-only-mode.js';

describe('classifyTool', () => {
  it('treats tools without confirm or dryRun as read-only with open-world hints', () => {
    expect(classifyTool('fortnox_list_invoices', ['page', 'limit', 'includeRaw'])).toEqual({
      access: 'read',
      annotations: { readOnlyHint: true, openWorldHint: true },
    });
  });

  it('treats a confirm or dryRun field as a potential mutation with explicit hints', () => {
    expect(classifyTool('fortnox_create_customer', ['Name', 'confirm', 'dryRun'])).toEqual({
      access: 'potential-mutation',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
  });

  it('classifies a download tool with an output path as a local write, not a read', () => {
    expect(classifyTool('fortnox_get_voucher_file', ['fileId', 'outputPath', 'overwrite'])).toEqual(
      {
        access: 'local-write',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    );
  });

  it('keeps a confirm-gated tool with an output path a potential mutation', () => {
    const result = classifyTool('fortnox_invoice_pdf', ['outputPath', 'confirm', 'dryRun']);
    expect(result.access).toBe('potential-mutation');
  });

  it('classifies a read mode with an optional mutation flag as a potential mutation', () => {
    const result = classifyTool('fortnox_invoice_pdf', [
      'documentNumber',
      'markSent',
      'confirm',
      'dryRun',
    ]);
    expect(result.access).toBe('potential-mutation');
    expect(result.annotations.readOnlyHint).toBe(false);
  });

  it('marks delete and cancel tools destructive by name', () => {
    expect(
      classifyTool('fortnox_delete_customer', ['customerNumber', 'confirm', 'dryRun']).annotations
        .destructiveHint,
    ).toBe(true);
    expect(
      classifyTool('fortnox_cancel_invoice', ['documentNumber', 'confirm', 'dryRun']).annotations
        .destructiveHint,
    ).toBe(true);
  });

  it('marks update, patch and replace tools destructive because they overwrite data', () => {
    for (const name of [
      'fortnox_update_customer',
      'fortnox_patch_recurring',
      'fortnox_replace_recurring',
      'fortnox_update_scheduletime',
    ]) {
      expect(classifyTool(name, ['confirm', 'dryRun']).annotations.destructiveHint, name).toBe(
        true,
      );
    }
  });

  it('marks explicitly listed irreversible tools destructive', () => {
    for (const name of [
      'fortnox_credit_invoice',
      'fortnox_credit_supplier_invoice',
      'fortnox_detach_document_attachment',
      'fortnox_finish_contract',
      'fortnox_reset_scheduletime_day',
    ]) {
      expect(classifyTool(name, ['confirm', 'dryRun']).annotations.destructiveHint).toBe(true);
    }
  });

  it('keeps ordinary writes explicitly non-destructive', () => {
    expect(
      classifyTool('fortnox_create_invoice', ['CustomerNumber', 'confirm', 'dryRun']).annotations
        .destructiveHint,
    ).toBe(false);
    expect(
      classifyTool('fortnox_send_invoice', ['documentNumber', 'confirm', 'dryRun']).annotations
        .destructiveHint,
    ).toBe(false);
  });

  it('marks update, patch and replace mutations idempotent and others not', () => {
    const fields = ['confirm', 'dryRun'];
    for (const name of [
      'fortnox_update_customer',
      'fortnox_patch_recurring',
      'fortnox_replace_recurring',
    ]) {
      expect(classifyTool(name, fields).annotations.idempotentHint).toBe(true);
    }
    expect(classifyTool('fortnox_create_customer', fields).annotations.idempotentHint).toBe(false);
    expect(classifyTool('fortnox_send_invoice', fields).annotations.idempotentHint).toBe(false);
  });

  it('keeps the local shadow status tool closed-world', () => {
    expect(classifyTool('fortnox_shadow_status', [])).toEqual({
      access: 'read',
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
  });
});

describe('parseReadOnlyEnv', () => {
  it('is off when unset, empty, 0 or false', () => {
    expect(parseReadOnlyEnv(undefined)).toBe(false);
    expect(parseReadOnlyEnv('')).toBe(false);
    expect(parseReadOnlyEnv('0')).toBe(false);
    expect(parseReadOnlyEnv('false')).toBe(false);
    expect(parseReadOnlyEnv('FALSE')).toBe(false);
  });

  it('is on for 1 or true in any letter case', () => {
    expect(parseReadOnlyEnv('1')).toBe(true);
    expect(parseReadOnlyEnv('true')).toBe(true);
    expect(parseReadOnlyEnv('TRUE')).toBe(true);
    expect(parseReadOnlyEnv('True')).toBe(true);
  });

  it('throws for any other value so a misspelling never starts a writable server', () => {
    for (const value of ['yes', 'on', 'no', 'tru', ' true', 'true ', '2', '-1']) {
      expect(() => parseReadOnlyEnv(value)).toThrow(InvalidReadOnlyEnvError);
    }
  });

  it('does not echo the rejected value in its message', () => {
    let message = '';
    try {
      parseReadOnlyEnv('sekret-value');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(READ_ONLY_ENV);
    expect(message).not.toContain('sekret-value');
  });
});
