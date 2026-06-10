# Project Status

**Last session:** 2026-06-10
**Branch:** `fix/issue-batch-bugs-enhancements` — pushed, PR #35 open

## Completed This Session

Batch-fixed 11 GitHub issues (both open bugs + all tractable enhancements), one commit per issue, red/green TDD throughout. 552 unit tests (up from 499), lint clean.

- **#31 (bug)** — `customers create/update` strip server-derived read-only fields (`Country`, `DeliveryCountry`, `VisitingCountry`) in the operations layer.
- **#34 (bug)** — single-resource JSON output consistently wrapped under the singular key (`{"Invoice": {...}}`); `-o` help documents the TTY/piped default. **Breaking** for scripts consuming bare objects (CHANGELOG Unreleased → Changed).
- **#32** — JSON-mode failures emit `{"error": {status?, message, hint?, source}}` to stderr (`errorEnvelope` in formatter.ts).
- **#6** — confirmation prompt prints the request payload before y/N.
- **#8** — `noxctl completion bash|zsh|fish` (src/completions.ts, generated from the Commander tree).
- **#9** — `--period` natural dates (src/date-periods.ts): Q1/2025-Q3/month names (en+sv)/last-quarter/ytd/year. Calendar-year based; fiscal-year design still open.
- **#33** — YubiKey serial enrollment diagnostics: init records serial to `~/.fortnox-mcp/keychain-serial`, unlock preflights `ykman list --serials`, ykman's "empty slot"/"Failed to write" errors translated.
- **#11** — financial years + locked period (operations/tools/CLI).
- **#10** — Contracts API: list/get/create/update/finish/create-invoice/increase-invoice-count.
- **#7** — analytics ops (src/operations/analytics.ts): overdue summary, unpaid totals, top customers, VAT summary with netVat. Pure aggregation functions unit-tested.
- **#12** — `noxctl dashboard` composing the analytics ops.

Issue triage: closed #16 (multi-profile — shipped in 0.2.0); commented on #13 (still blocked on Fortnox API scope config).

## In Progress

- **PR #35 awaiting review/merge.** Merging auto-closes the 11 issues.

## Blockers

None.

## Next Steps

- Review + merge PR #35.
- Live-verify the new endpoints against the real API (`npm run test:live`); contracts/financial-years were only tested against mocks.
- Consider version bump (0.3.0 given the #34 breaking envelope change) + CHANGELOG release entry.
- Recurring `api-drift` spec-fetch failures (HTTP 429, issues #5–#30) are still unaddressed — the weekly fetch has failed since March; worth fixing the fetch script (retry/backoff or new URL) and closing the stale issues.
