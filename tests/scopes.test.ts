import { describe, it, expect } from 'vitest';
import { SCOPES, SALARY_SCOPE, effectiveScopes, buildAuthorizationUrl } from '../src/auth.js';

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

  // The Lön (salary) scope is opt-in: it must NOT be in the default set, because
  // requesting it fails for users whose Fortnox app lacks the Lön permission.
  it('does not include the opt-in salary scope by default', () => {
    expect(SALARY_SCOPE).toBe('salary');
    expect(requested).not.toContain('salary');
  });
});

describe('effectiveScopes', () => {
  it('falls back to the default SCOPES when no scopes are recorded', () => {
    expect(effectiveScopes(null)).toBe(SCOPES);
    expect(effectiveScopes(undefined)).toBe(SCOPES);
    expect(effectiveScopes({})).toBe(SCOPES);
  });

  it('returns the recorded scopes when present (e.g. opted-in salary)', () => {
    const granted = `${SCOPES} ${SALARY_SCOPE}`;
    expect(effectiveScopes({ scopes: granted })).toBe(granted);
  });
});

describe('buildAuthorizationUrl scope handling', () => {
  it('requests the default scopes when none are supplied', () => {
    const url = new URL(
      buildAuthorizationUrl({ clientId: 'cid', clientSecret: 'secret' }, 'http://x/cb', 's'),
    );
    expect(url.searchParams.get('scope')).toBe(SCOPES);
    expect(url.searchParams.get('scope')).not.toContain('salary');
  });

  it('requests the salary scope when opted in', () => {
    const granted = `${SCOPES} ${SALARY_SCOPE}`;
    const url = new URL(
      buildAuthorizationUrl(
        { clientId: 'cid', clientSecret: 'secret' },
        'http://x/cb',
        's',
        granted,
      ),
    );
    expect(url.searchParams.get('scope')).toBe(granted);
    expect(url.searchParams.get('scope')).toContain('salary');
  });
});
