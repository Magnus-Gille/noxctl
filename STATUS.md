# Project Status

**Last session:** 2026-04-20
**Branch:** chunk-e-mcp-profile-binding

## Completed This Session

- **Chunk E implemented on branch `chunk-e-mcp-profile-binding`** (not yet pushed/PR'd)
  - `src/index.ts` — new `resolveStartupProfile()` and `bindStartupProfile()` (env `NOXCTL_PROFILE` + active pointer, no flag); `startMcpServer(options?)` accepts `{ profile? }`, binds via `setResolvedProfile`, emits `[profile: <name>]` stderr banner for non-default profile
  - `src/cli.ts` — `serve` action forwards `resolvedProfileInfo.name` to `startMcpServer`, preserving `--profile` flag through the CLI→MCP boundary
  - `src/fortnox-client.ts` — `FortnoxApiError` message prefixed with `[profile: <name>]` when non-default (single chokepoint surfaces profile in every tool error)
  - `src/auth.ts` — `getValidToken` "Not authenticated" error includes profile name and suggests `noxctl init --profile <name>` when non-default
  - Tests: new `tests/mcp-profile.test.ts` (resolveStartupProfile + bindStartupProfile precedence, banner, invalid-name fallback); extended `tests/fortnox-client.test.ts` (profile tag on error, default omits prefix); extended `tests/auth.test.ts` (tagged not-authenticated error)

## Verified Locally

- `npm run build` clean
- `npm run lint` clean
- `npm test` — 448/448 passing (+13 new)

## Next Steps (priority order)

1. **Push branch + open PR** for Chunk E; request Codex review
2. **Docs** — README profile section, MIGRATION.md (0.1→0.2 upgrade path), CHANGELOG entry
3. **0.2.0 release** — bump `package.json`, `src/cli.ts` version string, `src/index.ts` server version, publish
