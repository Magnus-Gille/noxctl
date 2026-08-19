# Project Status

**Last session:** 2026-08-19
**Branch:** `main` at `17aef1d` (synchronized with `origin/main`)
**Published:** `v0.7.0`, `v0.7.1`, `v0.7.2` tagged and released on GitHub. **npm still serves `0.6.1`** — see Blockers.

## Completed This Session

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

Nothing. Working tree clean, no open PRs.

## Blockers

- **`npm publish` has not run.** npm serves `0.6.1` as `latest` while GitHub advertises v0.7.2. It stops at the 2FA one-time password, which needs an interactive terminal — run `npm publish` from the repo root on `main`. A single publish ships all three releases, since 0.7.2 supersedes 0.7.0/0.7.1.
- Rollback if needed: `npm dist-tag add noxctl@0.6.1 latest`, then `npm deprecate noxctl@0.7.2 "<reason>"`.

## Next Steps

1. **Run `npm publish`** (see Blockers) — the only thing between this work and users.
2. **Close the schema-drift bug class.** #96 and #101 were the same defect: a hand-maintained Zod schema drifting from the Fortnox spec, with the MCP SDK silently discarding undeclared arguments. A test diffing each write tool's declared schema against the cached OpenAPI payload schema would catch the next one across all 27 resource modules. This is the highest-value remaining work.
3. **Automate the version bump.** Five files carry the version (`package.json`, `package-lock.json`, `src/cli.ts`, `src/index.ts`, `server.json`); `server.json` had silently drifted three releases behind because nothing checks it. An `npm version` hook or release workflow removes the class.
4. Confirm against a live account whether Fortnox really overwrites voucher-row `Description` with the account's registered name. Adopted from @hedborg's report but **not independently verified** — verifying needs a real voucher mutation. The docs currently say "normally".
5. `#13` (bank transactions) remains blocked upstream. The 2026-08-17 spec added `/api/bank-process-*`, but those are company-formation/KYC onboarding, not transactions. Revisit only if the drift workflow reports a genuinely transactional bank path.

## Notes

- Two rounds of Codex cross-model review (gpt-5.6-sol, high effort) ran on #97 and caught three real problems, including a terminal-escape regression introduced during the fix and a legacy-credential renewal bug that would have broken untouched installs on refresh. `LEGACY_SCOPES` exists because of that second finding — it is frozen history and must never be edited.
- Local `backup/pre-rewrite-*` branches must never be pushed publicly (pre-sanitization history).
- @hedborg has filed three high-quality reports with root-cause analysis and tested patches, and has offered PRs each time.
