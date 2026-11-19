import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  clearInvoiceDefaultBcc,
  invoiceSendDefaultsFile,
  readInvoiceSendDefaults,
  setInvoiceDefaultBcc,
} from '../src/invoice-send-defaults.js';

let tmpRoot: string;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noxctl-send-defaults-'));
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
});

afterEach(async () => {
  process.env.HOME = ORIGINAL_HOME;
  process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('invoice send defaults', () => {
  it('has no default BCC until one is configured', async () => {
    expect(await readInvoiceSendDefaults('default')).toEqual({});
  });

  it('stores a default BCC per profile', async () => {
    await setInvoiceDefaultBcc('work', 'copy@example.com');
    expect(await readInvoiceSendDefaults('work')).toEqual({ bcc: 'copy@example.com' });
  });

  it('keeps profiles isolated from each other', async () => {
    await setInvoiceDefaultBcc('work', 'work-copy@example.com');
    await setInvoiceDefaultBcc('demo', 'demo-copy@example.com');
    expect(await readInvoiceSendDefaults('default')).toEqual({});
    expect(await readInvoiceSendDefaults('work')).toEqual({ bcc: 'work-copy@example.com' });
    expect(await readInvoiceSendDefaults('demo')).toEqual({ bcc: 'demo-copy@example.com' });

    await clearInvoiceDefaultBcc('work');
    expect(await readInvoiceSendDefaults('work')).toEqual({});
    expect(await readInvoiceSendDefaults('demo')).toEqual({ bcc: 'demo-copy@example.com' });
  });

  it('matches profile names case-insensitively, like the profile index', async () => {
    await setInvoiceDefaultBcc('Work', 'copy@example.com');
    expect(await readInvoiceSendDefaults('work')).toEqual({ bcc: 'copy@example.com' });
  });

  it('rejects something that is not a single email address', async () => {
    await expect(setInvoiceDefaultBcc('work', 'not-an-address')).rejects.toThrow(/email/i);
    await expect(setInvoiceDefaultBcc('work', 'a@b.se, c@d.se')).rejects.toThrow(/email/i);
    expect(await readInvoiceSendDefaults('work')).toEqual({});
  });

  it('trims whitespace around the stored address', async () => {
    await setInvoiceDefaultBcc('work', '  copy@example.com ');
    expect(await readInvoiceSendDefaults('work')).toEqual({ bcc: 'copy@example.com' });
  });

  // A corrupt settings file must not silently drop the configured copy: the
  // send would then go out without the BCC the user relies on.
  it('fails loudly on a corrupt settings file instead of sending without the copy', async () => {
    await fs.mkdir(path.dirname(invoiceSendDefaultsFile()), { recursive: true });
    await fs.writeFile(invoiceSendDefaultsFile(), '{not json');
    await expect(readInvoiceSendDefaults('work')).rejects.toThrow(/invoice-send-defaults/);
  });

  it('writes the settings file with owner-only permissions', async () => {
    if (process.platform === 'win32') return;
    await setInvoiceDefaultBcc('work', 'copy@example.com');
    const stat = await fs.stat(invoiceSendDefaultsFile());
    expect(stat.mode & 0o077).toBe(0);
  });
});
