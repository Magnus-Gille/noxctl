# Project Status

**Last session:** 2026-04-20
**Branch:** chunk-e-mcp-profile-binding (PR #22 open)

## Completed This Session

- **Chunk E implemented, reviewed, and post-critique fixes applied**
  - Initial implementation:
    - `src/index.ts` — `resolveStartupProfile()` / `bindStartupProfile()` / `startMcpServer({ profile? })`; stderr banner for non-default
    - `src/cli.ts` — `serve` action forwards `resolvedProfileInfo.name` to `startMcpServer`
    - `src/fortnox-client.ts` — `FortnoxApiError` prefixed with `[profile: <name>]`
    - `src/auth.ts` — `getValidToken` "Not authenticated" tagged with profile
  - Post-critique fixes (addressing all 8 Codex debate action items):
    - `src/profiles.ts` — typed `PointerOutcome` union + `readActivePointerOutcome()` with `AbortController`-based timeout (actually cancels the I/O)
    - `src/index.ts` — `StartupProfileError` (codes: `invalid-pointer-content | pointer-read-error | pointer-timeout | invalid-env`); `resolveStartupProfile` fails closed on pointer faults unless env overrides; env invalid also fails closed
    - `src/cli.ts` — preAction fails closed **only** when `name === 'serve'` AND no flag/env; `doctor` / `profile use` can still repair corrupt state; banner dedupe via `name === 'serve'` check (MCP owns the banner on `serve`)
    - `src/auth.ts` — broadened profile-tagging to `refreshAccessToken` + `getTokenViaClientCredentials` (not just `FortnoxApiError`)
    - `tests/mcp-integration-profile.test.ts` — in-process `Client` ↔ `Server` via `InMemoryTransport` asserts `[profile: staging]` surfaces in tool error; mirror test for default; CLI→MCP handoff seam test (sabotaged pointer + explicit profile option → must not read pointer)
    - `tests/mcp-profile.test.ts` — replaced fail-open expectations with `StartupProfileError` assertions; added env-overrides-corrupt-pointer-with-warning test
    - `tests/auth.test.ts` — tagging tests for refresh + client-credentials paths
- **Adversarial review (Codex, gpt-5.4 xhigh, 2 rounds)**
  - 5 Round-1 findings, 15 total critique points logged in `debate/mcp-profile-binding-critique-log.json`
  - All actionable items implemented; "chokepoint" framing narrowed per Round 2 guidance

## Verified Locally

- `npm run build` clean
- `npm run lint` clean
- `npm test` — **456/456 passing** (+21 net new vs main)

## Next Steps (priority order)

1. **Push post-critique fixes to PR #22** and update PR description to narrow chokepoint framing
2. **Docs** — README profile section, MIGRATION.md (0.1→0.2 upgrade path), CHANGELOG entry
3. **0.2.0 release** — bump `package.json`, `src/cli.ts` version string, `src/index.ts` server version, publish
