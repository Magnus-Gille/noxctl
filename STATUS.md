# Project Status

**Last session:** 2026-06-16
**Branch:** `main` (all session work merged)

## Completed This Session

Worked through a full PR + review + merge pipeline autonomously (cross-model Codex review loops).

- **PR #35 merged** — the 11-issue batch (bugs + enhancements). Before merging, ran 5 rounds of Codex review and fixed 9 findings across 4 commits:
  - credentials-store: fail closed instead of leaking the secret to `security -w` argv.
  - analytics: local-calendar `localIsoDate` (UTC off-by-one) + extracted/tested `netVatFromVatAccounts`.
  - analytics: `dashboardWindowStart` avoids end-of-month overflow (Jul 31 → Feb 1, not Mar 1).
  - keychain-target: `setLockOnSleep`/`lockKeychain` throw on non-zero `security` exit.
  - cli: JSON error envelope now also covers Commander parse errors and the `--profile`/`serve`/`requireDarwin` direct-exit paths (via a `fail()` helper + moving `configureOutput`/`exitOverride` above the command tree). Interactive keychain/init wizards intentionally stay plain-text.
  - Auto-closed #6,#7,#8,#9,#10,#11,#12,#31,#32,#33,#34.
- **PR #38 merged (#37)** — voucher file attachments: `noxctl vouchers attach <series> <number> <file...> [--year]` + `fortnox_attach_voucher_files` MCP tool. Two-step inbox upload → voucherfileconnection; `fortnox-client` gained `rawBody`/multipart support (`archive` scope). 2 Codex rounds + fixes (pre-flight file/dir validation, throwing year resolution, mid-batch error surfacing, MIME types, includeRaw). Verified against Fortnox docs that the upload `Id` (not ArchiveFileId) is the connection FileId.
- **#13 split & documented** — file-attachments half delivered by #37; bank-transactions half stays open & blocked (no `/3/bank` in the OpenAPI spec; separate Bank/Finans product/scope).
- **api-drift triaged & fixed** — the 12 weekly "fetch failed" issues were one persistent **HTTP 429** from the `openapi.json` endpoint (since 2026-03-30). Closed all 12, consolidated into tracker **#39**; **PR #40** added a dedup guard. **#39 RESOLVED — PR #42:** restored the drift check by fetching the ReDoc docs page (browser UA) and extracting the spec from its inlined `__redoc_state` (`scripts/extract-redoc-spec.py`), since the JSON endpoint is hard-429'd. Verified green in CI (workflow_dispatch). Rejected a community mirror (rsystem-se/fortnox_openapi is archived/partial/unlicensed). Snapshot refreshed (baseline reset); caught real drift (asset `{GivenNumber}`→`{Id}`, noxfinansinvoices param rename).

## Open Issues

- **#13** — bank transactions only (blocked: not in the spec; needs Fortnox Bank/Finans API). Note: the refreshed spec now exposes `/3/noxfinansinvoices` (Fortnox Finans) — worth checking whether it covers part of this.

## Next Steps

- Live-verify the new endpoints against the real API (`npm run test:live`): attachments need the **archive** scope enabled on the Fortnox app; contracts/financial-years were only mock-tested.
- Consider 0.3.0 + CHANGELOG release entry (the #34 JSON-envelope change is breaking).
- Review the ~3 months of real API drift now captured in the refreshed snapshot for any endpoints worth adopting.

## Notes

- Test count: 588 unit tests, lint clean, build green on `main`.
- Codex CLI ran out of credits during the last #37 review round; that round was a Claude fallback (clean).
