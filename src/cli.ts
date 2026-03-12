#!/usr/bin/env node

import { runOAuthSetup } from './auth.js';

const args = process.argv.slice(2);
const command = args[0];

if (command === 'setup') {
  const clientId = process.env.FORTNOX_CLIENT_ID;
  const clientSecret = process.env.FORTNOX_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Error: FORTNOX_CLIENT_ID and FORTNOX_CLIENT_SECRET must be set.');
    console.error('');
    console.error('1. Go to https://developer.fortnox.se/');
    console.error('2. Create an app with redirect URI: http://localhost:9876/callback');
    console.error('3. Run:');
    console.error(
      '   FORTNOX_CLIENT_ID=<your-id> FORTNOX_CLIENT_SECRET=<your-secret> npx fortnox-mcp setup',
    );
    process.exit(1);
  }

  runOAuthSetup({ clientId, clientSecret })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Setup failed:', err.message);
      process.exit(1);
    });
} else {
  // Default: run MCP server
  import('./index.js');
}
