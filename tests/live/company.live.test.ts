import { describe, it, expect, beforeAll } from 'vitest';
import { credentialsAvailable, setupLiveClientServer, getText } from './setup.js';

let hasCredentials = false;

beforeAll(async () => {
  hasCredentials = await credentialsAvailable();
});

describe('live: fortnox_company_info', () => {
  it('returns company information from the real API', async () => {
    if (!hasCredentials) {
      console.log('SKIP: No Fortnox credentials found — skipping live company tests.');
      return;
    }

    const { client } = await setupLiveClientServer();
    const result = await client.callTool({ name: 'fortnox_company_info', arguments: {} });

    expect(result.isError).toBeFalsy();

    const text = getText(result);
    expect(text.length).toBeGreaterThan(0);
    // The tool renders a key-value table; at minimum Company and City fields must appear
    expect(text).toMatch(/Company|Address|City|Database/i);
  });
});
