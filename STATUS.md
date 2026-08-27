# Project Status

**Last session:** 2026-08-27
**Branch:** `fix/issue-108-report-voucher-concurrency`, with implementation commit `2e8d56d`, based on `main` at `4807d3c`
**Published:** `v0.7.2` on GitHub and `noxctl@0.7.2` on npm (registry verified 2026-08-27)

## Completed This Session

- **#108 — slow financial reports.** Voucher detail reads now use a five-worker pool while the shared Fortnox client remains responsible for the 25-request/5-second rate limit. Six-detail regression coverage proves requests overlap and never exceed five in flight.
- Financial reports now exclude voucher rows with `Removed: true`, matching the bookkeeping tool's existing contract that removed rows were replaced and must not be counted.
- Red/green verification captured both defects: concurrency was exactly one before the fix, and a removed row inflated the fixture total from 3,500 to 13,500. `npm run check:release` passes for `0.7.3` (73 files, 833 tests, zero production vulnerabilities, package dry-run successful).

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

Issue #108 and release candidate `0.7.3` are published for review in PR #109 from `fix/issue-108-report-voucher-concurrency`. Codex review and CI are the remaining merge gates.

## Blockers

None for PR #109 or the planned `0.7.3` release.

## Next Steps

1. Merge PR #109 after Codex review and all CI jobs pass, then tag and publish `v0.7.3` from the exact merge commit.
2. Verify the npm package and GitHub release, then notify and credit @MountRose76 on issue #108.
3. Triage open API-drift issue #107 independently of this user fix.
4. **Close the schema-drift bug class.** #96 and #101 were the same defect: a hand-maintained Zod schema drifting from the Fortnox spec, with the MCP SDK silently discarding undeclared arguments. A test diffing each write tool's declared schema against the cached OpenAPI payload schema would catch the next one across all 27 resource modules.
5. **Automate the version bump.** Five files carry the version (`package.json`, `package-lock.json`, `src/cli.ts`, `src/index.ts`, `server.json`); `server.json` had silently drifted three releases behind because nothing checks it.
6. Confirm against a live account whether Fortnox really overwrites voucher-row `Description` with the account's registered name. Adopted from @hedborg's report but **not independently verified** — verifying needs a real voucher mutation. The docs currently say "normally".
7. `#13` (bank transactions) remains blocked upstream. Revisit only if the drift workflow reports a genuinely transactional bank path.

## Notes

- Two rounds of Codex cross-model review (gpt-5.6-sol, high effort) ran on #97 and caught three real problems, including a terminal-escape regression introduced during the fix and a legacy-credential renewal bug that would have broken untouched installs on refresh. `LEGACY_SCOPES` exists because of that second finding — it is frozen history and must never be edited.
- Issue #108 received a fresh local `qwen3-coder-next-80b` review after deterministic checks. Its proposed JavaScript data races and removed-row test gap were validated and declined: no code can interleave inside the synchronous index claim, and the removed fixture demonstrably failed before the exclusion.
- Local `backup/pre-rewrite-*` branches must never be pushed publicly (pre-sanitization history).
- @hedborg has filed three high-quality reports with root-cause analysis and tested patches, and has offered PRs each time.
