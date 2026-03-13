import { describe, it, expect, beforeAll } from 'vitest';
import { credentialsAvailable, setupLiveClientServer, getText } from './setup.js';

let hasCredentials = false;

beforeAll(async () => {
  hasCredentials = await credentialsAvailable();
});

describe('live: fortnox_list_vouchers', () => {
  it('returns vouchers from the real API', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live voucher tests.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_vouchers',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
    // Tool renders a table with columns Series, Number, Date, Description
    // or a message saying there are no results
    expect(text).toMatch(/Series|Number|Date|Description|No results/i);
  });

  it('filters vouchers by series — picks the first series seen in the unfiltered list', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live voucher series filter test.');
      return;
    }

    // First fetch all vouchers and discover which series exist
    const { client } = await setupLiveClientServer();
    const allResult = await client.callTool({ name: 'fortnox_list_vouchers', arguments: {} });
    expect(allResult.isError).toBeFalsy();

    const allText = getText(allResult);
    // Extract a single uppercase letter from the Series column (first char of any row)
    const seriesMatch = allText.match(/^([A-Z])\s+\d+/m);
    if (!seriesMatch) {
      // No vouchers at all — nothing to filter
      return;
    }
    const series = seriesMatch[1];

    const filteredResult = await client.callTool({
      name: 'fortnox_list_vouchers',
      arguments: { series },
    });

    expect(filteredResult.isError).toBeFalsy();

    const filteredText = getText(filteredResult);
    expect(filteredText.length).toBeGreaterThan(0);
  });
});
