# Project Status

**Last session:** 2026-08-28
**Branch:** `feat/122-embedded-api` (stacked on `feat/119-tenant-client` → `feat/120-client-bound-operations` → `feat/121-tenant-bound-mcp`)
**Published:** `v0.7.4` on GitHub and `noxctl@0.7.4` on npm (both verified 2026-08-28)

## Completed This Session

- Created hosted-product epic #118 and implementation tickets #119–#122 for the public reusable core; the private OAuth/session/token-vault/billing/operations host remains intentionally outside this repository.
- Added isolated per-tenant Fortnox clients, transport-bound operation factories across all resource families, tenant-bound MCP server construction, and the supported `noxctl/embedded` package entry point while preserving local CLI/stdio behavior.
- Added fail-closed embedded server construction, per-tenant rate-limit and diagnostic isolation tests, and non-retryable classification for invoice email/e-invoice delivery actions.
- Added a real packed-package consumer gate covering runtime imports, TypeScript declarations, forbidden embedded exports, missing-transport rejection, and the packaged CLI help path. `npm run check:release` passes with 847 tests across 76 files and zero production vulnerabilities.
- A fresh isolated Codex reviewer found the missing fail-closed embedded wrapper and invoice-delivery retry bug; both were fixed and regression-tested. Claude Code review was unavailable because its local CLI was not authenticated, so this review was independent-context but not cross-provider.
- Refreshed the README opening for first-time visitors: trust model, badges and a GitHub-native callout, accurate value summary, global-install and `npx` quick starts, and navigation into the long-form reference.
- Corrected stale pre-rename clone and private-security-advisory links, and added canonical repository/bugs/homepage plus discovery keywords to npm package metadata.
- Verified GitHub Markdown rendering, local links/anchors, package metadata and dry-run contents, lint, TypeScript formatting, build, and all 833 tests across 73 files.
- Published PR #112 and updated the GitHub About description, npm homepage, and ten discovery topics. The refreshed public Open Graph metadata now uses the broader CLI/MCP positioning.
- Codex review found and fixed two documentation issues before PR #112 merged as `6be163c60856da775b05470a0100b0af65adae8c`: an over-broad `npx` instruction and a brittle hard-coded test count.
- Prepared and reviewed release PR #114, then merged it as `db369322955cae863ac1a372fa8cba6cb67c3712`. The release gate passed with 833 tests across 73 files, zero production vulnerabilities, and a successful package dry run.
- Published `noxctl@0.7.4` to npm and created the matching GitHub release. npm `latest` resolves to `0.7.4`; the registry SHA-1 `6180f1632a31f5ee3e29e921e5b09bfd0b592e19` matches the reviewed tarball, and a clean install reports `0.7.4`.

## Previous Session (2026-08-27)

- **#108 — slow financial reports.** Voucher detail reads now use a five-worker pool while the shared Fortnox client remains responsible for the 25-request/5-second rate limit. Six-detail regression coverage proves requests overlap and never exceed five in flight.
- Financial reports now exclude voucher rows with `Removed: true`, matching the bookkeeping tool's existing contract that removed rows were replaced and must not be counted.
- Red/green verification captured both defects: concurrency was exactly one before the fix, and a removed row inflated the fixture total from 3,500 to 13,500. `npm run check:release` passes for `0.7.3` (73 files, 833 tests, zero production vulnerabilities, package dry-run successful).
- PR #109 passed Codex review plus Ubuntu Node 22/24 and Windows Node 22 CI, then merged. The exact merge commit was tagged `v0.7.3`; npm `latest` resolves to `0.7.3`, and its registry SHA-1 `695254e7825e4140b3b910b67829940340121c20` matches the verified release tarball.
- @MountRose76 is credited in the changelog, PR, GitHub release, and the release notification on issue #108.
- API-drift issue #107 was triaged and closed with no implementation required: its changes only affect the already-known company-formation / bank-onboarding and KYC APIs. Fingerprint commit `652ff18` already captured them; #13 remains open for a genuinely transactional bank API.

## Previous Session (2026-08-19)

Three externally reported issues fixed, plus both open Dependabot PRs, across six merged PRs.

- **#95 — Windows OAuth and scopes** (#97). `openBrowser()` ran `cmd /c start <url>`; cmd.exe splits on the unescaped `&` in the query string, so Fortnox received a truncated authorization URL and rejected it. Now launches via PowerShell `Start-Process`, URL printed unconditionally. DPAPI helpers now `Add-Type -AssemblyName System.Security`. `project`/`costcenter`/`price` added to the default `SCOPES`; `offer`/`order` gated behind the new `--with-orders` because Fortnox requires the **Order licence** for them. `init` now prints the `SCOPES` constant itself rather than a hand-maintained list.
- **#96 — MCP tool gaps** (#97). Supplier create/update schemas expanded from 10 to all 41 writable fields. Voided voucher rows (`Removed: true`) now render `[REMOVED]`.
- **#101 — voucher row fields** (#102). `VoucherRowSchema` declared 4 of 9 writable fields, so `TransactionInformation` was silently stripped by the MCP SDK and never reached Fortnox. Now declares the full payload set.
- **#89 → #98**, **#91 → #99**. MCP SDK 1.30.0 (which allowed dropping the `@hono/node-server` override) and the dev-tooling bumps. Both original PRs were superseded and closed.
- **#94** closed — drift already cleared by `8c89e98`; verified `npm run check:api` reports no changes and that the flagged recurring-billing changes still match `src/operations/recurrings.ts`.

Found and fixed without being reported:
- 403 hints named the wrong scope for offers, orders and both payment families; `financialyears` was missing from the map entirely.
- Windows `logout --all` reported removing credentials that never existed (`fs.rm` with `force: true` resolves for a missing file).
- Column formatters bypassed terminal control-character stripping.
- CLI subprocess tests used a 10s timeout that flaked on cold Windows CI runners; now 30s (Vitest per-test 45s).

**CI now runs on `windows-latest`.** Every #95 bug was Windows-only; Linux-only CI could not have caught them. The new leg found the `logout --all` bug on its first run.

## In Progress

The public hosted-core implementation and its review history are tracked in PR #123. GitHub is authoritative for its current merge state. This work does not include an npm release, deployment, or production-host publication.

## Blockers

No public-core code blocker is known. The private hosted product still depends on answers from Fortnox about partner/App Market, OAuth, commercial, and data-processing requirements.

## Next Steps

1. Start the private `noxctl-cloud` repository only after Fortnox has answered the partner/App Market, OAuth, commercial, and data-processing questions recorded in epic #118.
2. **Close the schema-drift bug class.** #96 and #101 were the same defect: a hand-maintained Zod schema drifting from the Fortnox spec, with the MCP SDK silently discarding undeclared arguments. A test diffing each write tool's declared schema against the cached OpenAPI payload schema would catch the next one across all 27 resource modules.
3. **Automate the version bump.** Five files carry the version (`package.json`, `package-lock.json`, `src/cli.ts`, `src/index.ts`, `server.json`); `server.json` had silently drifted three releases behind because nothing checks it.
4. Confirm against a live account whether Fortnox really overwrites voucher-row `Description` with the account's registered name. Adopted from @hedborg's report but **not independently verified** — verifying needs a real voucher mutation. The docs currently say "normally".
5. `#13` (bank transactions) remains blocked upstream. Revisit only if the drift workflow reports a genuinely transactional bank path.

## Notes

- Two rounds of Codex cross-model review (gpt-5.6-sol, high effort) ran on #97 and caught three real problems, including a terminal-escape regression introduced during the fix and a legacy-credential renewal bug that would have broken untouched installs on refresh. `LEGACY_SCOPES` exists because of that second finding — it is frozen history and must never be edited.
- Issue #108 received a fresh local `qwen3-coder-next-80b` review after deterministic checks. Its proposed JavaScript data races and removed-row test gap were validated and declined: no code can interleave inside the synchronous index claim, and the removed fixture demonstrably failed before the exclusion.
- Local `backup/pre-rewrite-*` branches must never be pushed publicly (pre-sanitization history).
- @hedborg has filed three high-quality reports with root-cause analysis and tested patches, and has offered PRs each time.
