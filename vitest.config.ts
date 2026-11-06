import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Must exceed the CLI subprocess timeout in the tests that spawn `node
    // dist/cli.js`, or the test aborts before the subprocess reports anything.
    testTimeout: 45_000,
    // The shadow lane relies on POSIX private directories (0700, owner uid) and
    // refuses to start on Windows; tests/shadow-windows.test.ts covers that refusal. The
    // unpublished pilot host (tests/pilot) builds on that lane and is macOS/Linux only too.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/live/**',
      ...(process.platform === 'win32' ? ['tests/shadow/**', 'tests/pilot/**'] : []),
    ],
  },
});
