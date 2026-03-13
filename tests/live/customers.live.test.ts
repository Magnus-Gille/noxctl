import { describe, it, expect, beforeAll } from 'vitest';
import { credentialsAvailable, setupLiveClientServer, getText } from './setup.js';

let hasCredentials = false;

beforeAll(async () => {
  hasCredentials = await credentialsAvailable();
});

describe('live: fortnox_list_customers', () => {
  it('returns a list of customers from the real API', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live customer tests.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_customers',
      arguments: { limit: 5 },
    });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
    // The tool renders a table — there should be at least a header row
    expect(text).toMatch(/Kund|CustomerNumber|Namn|Name/i);
  });

  it('supports pagination — page 1 with limit 1', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live pagination test.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({
      name: 'fortnox_list_customers',
      arguments: { page: 1, limit: 1 },
    });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
  });
});
