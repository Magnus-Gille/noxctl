# Status

Last updated: 2026-03-12

## Branch

- `main`
- HEAD: `d0bd9e0` feat: add table formatter with TTY-sensitive output (#3)

## Completed This Session

- Performed deep security/privacy review across auth, Fortnox client, MCP tools, CLI, packaging, and docs
- Hardened OAuth setup:
  - callback server now binds to `127.0.0.1`
  - per-run OAuth `state` is generated and verified
  - callback HTML now escapes attacker-controlled values
- Replaced plaintext credential persistence with secure OS-backed storage:
  - macOS Keychain
  - Linux Secret Service via `secret-tool`
  - Windows DPAPI-protected user store
  - legacy `~/.fortnox-mcp/credentials.json` is migration-only and removed after secure save
- Stopped retrying non-idempotent Fortnox mutations; retries now apply only to idempotent requests
- Added dynamic path validation/encoding for customer numbers, invoice document numbers, and voucher series
- Added explicit confirmation barriers for all mutating MCP tools:
  - `confirm: true` required for execution
  - `dryRun: true` previews without side effects
- Reduced privacy exposure in MCP responses:
  - summary/table/detail output by default
  - raw Fortnox JSON is now opt-in via `includeRaw: true`
- Added matching CLI confirmation and `--dry-run` support for mutating commands
- Updated README/ARCHITECTURE docs to reflect the new security model
- Expanded test suite to cover new controls and regressions

## Verification

- `npm run build`
- `npm test` -> 131 tests passing
- `npm audit --omit=dev` -> 0 production vulnerabilities reported on 2026-03-12
- `npm run lint` is still broken in the repo because ESLint 10 expects `eslint.config.js` and the project does not have one yet

## Current Repo State

- Uncommitted security hardening across auth, CLI, tool responses, operations, docs, and tests
- New files:
  - `src/credentials-store.ts`
  - `src/identifiers.ts`
  - `src/tool-output.ts`

## Next Steps

- Review and commit the security/privacy hardening changes
- Decide whether to require `secret-tool` explicitly in Linux setup docs/install flow
- Consider adding idempotency keys or Fortnox-side reconciliation for mutations if the API supports it
- Fix the broken `npm run lint` configuration (`eslint.config.js` migration)
