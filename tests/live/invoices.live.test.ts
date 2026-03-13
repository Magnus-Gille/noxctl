import { describe, it, expect, beforeAll } from 'vitest';
import { credentialsAvailable, setupLiveClientServer, getText } from './setup.js';

let hasCredentials = false;

beforeAll(async () => {
  hasCredentials = await credentialsAvailable();
});

describe('live: fortnox_list_invoices', () => {
  it('returns a list of invoices from the real API', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live invoice tests.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_invoices',
      arguments: { limit: 5 },
    });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
    // Tool renders a table with columns Doc #, Customer, Date, Due, Total, Balance
    // or a message saying there are no results
    expect(text).toMatch(/Doc\s*#|Customer|Total|Balance|No results/i);
  });

  it('filters invoices by unpaid status', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live filter test.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_invoices',
      arguments: { filter: 'unpaid', limit: 5 },
    });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
  });

  it('filters invoices by date range', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live date filter test.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_invoices',
      arguments: { fromDate: '2024-01-01', toDate: '2024-12-31', limit: 5 },
    });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
  });
});
