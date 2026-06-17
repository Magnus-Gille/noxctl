import { describe, it, expect, beforeAll } from 'vitest';
import { salaryScopeAvailable, setupLiveClientServer, getText } from './setup.js';

// Read-only live check for the payroll (Lön) path. Requires a profile that was
// authorized with the opt-in `salary` scope (e.g. `noxctl init --with-salary`),
// so it skips against the default/non-payroll company rather than 403-ing.
let hasSalary = false;

beforeAll(async () => {
  hasSalary = await salaryScopeAvailable();
});

describe('live: fortnox_list_employees (payroll/Lön)', () => {
  it('lists employees from the real Salary API', async () => {
    if (!hasSalary) {
      console.log('SKIP: no salary-scoped credentials — skipping live payroll tests.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_employees',
      arguments: { limit: 1 },
    });

    // A 200 (even with zero employees) proves the scope + endpoint work live.
    expect(result.isError).toBeFalsy();
    expect(typeof getText(result)).toBe('string');
  });
});
