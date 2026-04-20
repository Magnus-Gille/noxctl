# Project Status

**Last session:** 2026-04-20
**Branch:** main

## Completed This Session

- **Chunk C PR #20 merged** (f981eaf) — credential migration + dual-read/write
  - Codex review on PR #20; medium (legacy-write fatal) + low (migrate from raw legacyBlob) fixed before merge
- **Chunk D implemented on branch `chunk-d-cli-surface`** (not yet pushed/PR'd)
  - `--profile <name>` global flag + Commander `preAction` hook resolving flag/env/pointer via `resolveProfile`
  - `setResolvedProfile()` called so every downstream op picks up the resolution
  - Stderr TTY-only `[profile: <name>]` indicator when non-default
  - New `profile` command group: `use <name>`, `current`, `list`
  - `init --profile <name>` — sets active pointer when first profile OR no pointer exists
  - `logout` now per-profile; `logout --all` iterates index + deletes legacy slot + pointer
  - `doctor` shows resolved profile + source, company cached, and surfaces corrupt/unknown active-pointer (Codex #18 finding #1)
  - `confirmMutation` appends cached `company_name` to the prompt via lazy credential load
  - Tests: extended `tests/cli.test.ts` smoke tests; new `tests/cli-profile.test.ts` covers precedence, `profile use` rejection, JSON vs table output

## Verified Locally

- `npm run build` clean
- `npm run lint` clean
- `npm test` — 433/433 passing

## Next Steps (priority order)

1. **Chunk E** — MCP server startup profile binding (`src/index.ts`): read resolved profile at startup, expose in `startMcpServer()`, surface profile context in tool errors
2. **Docs** — README profile section, MIGRATION.md (0.1→0.2 upgrade path), CHANGELOG entry
3. **0.2.0 release** — bump `package.json`, `src/cli.ts` version string, `src/index.ts` server version, publish
