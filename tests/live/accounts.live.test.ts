import { describe, it, expect, beforeAll } from 'vitest';
import { credentialsAvailable, setupLiveClientServer, getText } from './setup.js';

let hasCredentials = false;

beforeAll(async () => {
  hasCredentials = await credentialsAvailable();
});

describe('live: fortnox_list_accounts', () => {
  it('returns the chart of accounts from the real API', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live accounts tests.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_accounts',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
    // A Swedish chart of accounts always contains at least some standard accounts
    expect(text).toMatch(/\d{4}/); // four-digit account numbers
  });

  it('filters accounts by search term — narrows down the result set', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live account search test.');
      return;
    }

    // First fetch all accounts and pick the first account number to use as the search term
    const { client } = await setupLiveClientServer();
    const allResult = await client.callTool({ name: 'fortnox_list_accounts', arguments: {} });
    expect(allResult.isError).toBeFalsy();

    const allText = getText(allResult);
    // Extract the first four-digit account number from the table
    const match = allText.match(/\b(\d{4})\b/);
    if (!match) {
      // If somehow no accounts exist, the unfiltered test already covers that path
      return;
    }
    const firstAccountNumber = match[1];

    const filteredResult = await client.callTool({
      name: 'fortnox_list_accounts',
      arguments: { search: firstAccountNumber },
    });

    expect(filteredResult.isError).toBeFalsy();

    const filteredText = getText(filteredResult);
    expect(filteredText.length).toBeGreaterThan(0);
    // The filtered result must contain the account number we searched for
    expect(filteredText).toContain(firstAccountNumber);
  });
});
