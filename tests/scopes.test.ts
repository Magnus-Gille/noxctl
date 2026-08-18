import { describe, it, expect } from 'vitest';
import {
  SCOPES,
  SALARY_SCOPE,
  ORDER_SCOPES,
  LEGACY_SCOPES,
  effectiveScopes,
  buildAuthorizationUrl,
} from '../src/auth.js';

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
      'payment', // /3/invoicepayments, /3/supplierinvoicepayments
      'project', // /3/projects (#95)
      'costcenter', // /3/costcenters (#95)
      'price', // /3/pricelists, /3/prices (#95)
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

  // Same reasoning as salary: per Fortnox's published scope table, `offer` and
  // `order` require the *Order* licence, which a Bokföring + Kundfaktura
  // customer does not have. Requesting them unconditionally would make `noxctl
  // init` impossible for those companies, so they are opt-in too. Every other
  // default scope needs only Bokföring, Kundfaktura or Order — never a licence
  // the pre-existing defaults did not already require.
  it('does not include the licence-gated order scopes by default', () => {
    expect(ORDER_SCOPES).toBe('offer order');
    expect(requested).not.toContain('offer');
    expect(requested).not.toContain('order');
  });
});

describe('effectiveScopes', () => {
  // Credentials written before the `scopes` field existed recorded nothing.
  // Renewing them against the *current* SCOPES would silently ask for scopes
  // their Fortnox app was never granted; a rejected client-credentials renewal
  // then falls back to a refresh token that service-account installs do not
  // rotate and that Fortnox expires after 45 days. Keep asking for exactly what
  // they consented to until the user re-runs `noxctl init`.
  it('falls back to the frozen legacy scope set when no scopes are recorded', () => {
    expect(effectiveScopes(null)).toBe(LEGACY_SCOPES);
    expect(effectiveScopes(undefined)).toBe(LEGACY_SCOPES);
    expect(effectiveScopes({})).toBe(LEGACY_SCOPES);
  });

  it('never widens a legacy credential beyond what it was granted', () => {
    const legacy = effectiveScopes({}).split(' ');
    for (const added of ['project', 'costcenter', 'price', 'offer', 'order']) {
      expect(legacy).not.toContain(added);
    }
  });

  it('keeps the legacy set frozen', () => {
    expect(LEGACY_SCOPES).toBe(
      'article customer invoice payment supplier supplierinvoice bookkeeping companyinformation settings inbox connectfile',
    );
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

  it('requests the order scopes when opted in', () => {
    const granted = `${SCOPES} ${ORDER_SCOPES}`;
    const url = new URL(
      buildAuthorizationUrl(
        { clientId: 'cid', clientSecret: 'secret' },
        'http://x/cb',
        's',
        granted,
      ),
    );
    expect(url.searchParams.get('scope')).toBe(granted);
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
