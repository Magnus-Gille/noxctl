import { describe, it, expect } from 'vitest';
import { SCOPES, SALARY_SCOPE, ORDER_SCOPES, LEGACY_SCOPES } from '../src/auth.js';
import { scopeProbeEndpoints } from '../src/scope-probes.js';

// `noxctl doctor` / `fortnox_status` probe one endpoint per granted scope and
// then report "all N scopes authorized". A scope with no probe is skipped by the
// loop but still counted in N, so an unprobed scope would be reported as
// authorized without ever being checked. Coverage has to be total.
describe('scope probe coverage', () => {
  const everyScope = [
    ...SCOPES.split(' '),
    ...ORDER_SCOPES.split(' '),
    SALARY_SCOPE,
    ...LEGACY_SCOPES.split(' '),
  ];

  it.each([...new Set(everyScope)])('has a probe endpoint for %s', (scope) => {
    expect(scopeProbeEndpoints[scope]).toBeTruthy();
  });

  it('does not probe scopes that are never requested', () => {
    for (const scope of Object.keys(scopeProbeEndpoints)) {
      expect(everyScope).toContain(scope);
    }
  });
});
