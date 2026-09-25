import { describe, expect, it } from 'vitest';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import path from 'node:path';

const CLI_PATH = path.resolve('dist/cli.js');
const execOpts: ExecFileSyncOptions = { encoding: 'utf-8', timeout: 30_000 };

function help(...args: string[]): string {
  return (execFileSync('node', [CLI_PATH, ...args, '--help'], execOpts) as string).replace(
    /\s+/g,
    ' ',
  );
}

describe('CLI command guidance', () => {
  it('distinguishes VAT reports, summaries, filtered invoice rows, and the dashboard', () => {
    expect(help('tax', 'report')).toContain('analytics vat');
    expect(help('analytics', 'vat')).toContain('netVat');

    const analyticsHelp = help('analytics');
    expect(analyticsHelp).toContain('invoices list --filter');
    expect(analyticsHelp).toContain('tax report');

    const dashboardHelp = help('dashboard');
    expect(dashboardHelp).toContain('Combined');
    expect(dashboardHelp).toContain('analytics unpaid');
    expect(dashboardHelp).toContain('invoices list --filter unpaid');
  });

  it('points legacy contracts and the ETag-based Recurring Billing API to the right groups', () => {
    expect(help('contracts')).toContain('legacy contract-based');

    const recurringsHelp = help('recurrings');
    expect(recurringsHelp).toContain('ETag');
    expect(recurringsHelp).toContain('JSON Patch');
    expect(help('recurrings', 'patch')).toContain('JSON Patch array');
  });

  it('describes file storage, document linking, and supported attachment listing', () => {
    const archiveHelp = help('archive');
    expect(archiveHelp).toContain('Uploading stores the file');
    expect(archiveHelp).toContain('attachments attach');

    const inboxHelp = help('inbox');
    expect(inboxHelp).toContain('does not connect it to a supplier invoice');
    expect(inboxHelp).toContain('supplier-invoices connect-file');

    const attachmentHelp = help('attachments');
    expect(attachmentHelp).toContain(
      'F (customer invoice), OF (offer), O (order), and C (contract)',
    );
    expect(attachmentHelp).toContain('supports OF, O, and C');
    expect(attachmentHelp).toContain('Count attachments');
    expect(attachmentHelp).toContain('Validate a JSON attachment list');
    expect(attachmentHelp).toContain('Update fields on an existing document attachment');
    expect(attachmentHelp).toContain('Detach an existing file connection');

    expect(help('invoices', 'attachments')).toContain('upload local files and attach them');
    expect(help('supplier-invoices', 'attachments')).toContain('does not upload files');
  });
});
