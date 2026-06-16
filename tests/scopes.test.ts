import { describe, it, expect } from 'vitest';
import { SCOPES } from '../src/auth.js';

// Guards the bug where the voucher file-attachment feature (#37) shipped without
// requesting the scopes it needs: noxctl only ever gets scopes it lists here, so
// every implemented endpoint family must have its scope in this set.
describe('OAuth SCOPES', () => {
  const requested = SCOPES.split(' ');

  it('requests the scopes backing the implemented features', () => {
    for (const scope of [
      'article',
      'customer',
      'invoice',
      'supplier',
      'supplierinvoice',
      'bookkeeping',
      'companyinformation',
      'settings',
      'inbox', // POST /3/inbox — voucher file upload (#37)
      'connectfile', // POST /3/voucherfileconnections — link file to voucher (#37)
    ]) {
      expect(requested).toContain(scope);
    }
  });

  it('has no duplicate scope tokens', () => {
    expect(new Set(requested).size).toBe(requested.length);
  });
});
