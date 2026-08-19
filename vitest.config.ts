import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Must exceed the CLI subprocess timeout in the tests that spawn `node
    // dist/cli.js`, or the test aborts before the subprocess reports anything.
    testTimeout: 45_000,
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/live/**'],
  },
});
