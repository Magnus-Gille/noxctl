# Changelog

All notable changes to noxctl are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-07-13

### Fixed

- Coalesce concurrent OAuth refreshes per profile so refresh-token rotation cannot race or overwrite newer credentials.
- Bound Fortnox and OAuth network calls with explicit deadlines. Read-only requests retry transient network failures and retryable HTTP responses with capped backoff; mutations remain single-attempt and timeout errors warn that their outcome may be unknown.

### Changed

- **Legacy credential dual-write disabled** (#53) — `saveCredentialBlob` no longer mirrors writes to the pre-0.2.0 unnamespaced keychain/DPAPI slot. The 0.2.x compatibility window (`LEGACY_DUAL_WRITE`) has passed; new credential saves go only to the namespaced `profile:default` slot. Reading the legacy slot is unaffected — `loadCredentialBlob` still transparently falls back to it, so already-migrated 0.1.x installs keep working. See `docs/legacy-credential-removal-plan.md` for the planned 0.5.0 removal of the legacy reader.
- Default employee detail output now redacts personnummer and exact pay. Exact values remain available through explicit CLI JSON output or MCP `includeRaw`, whose descriptions now warn that payroll data can include sensitive personal information.
- CI and package publishing now require lint, formatting, build, tests, a production dependency audit, and a package manifest dry-run. Safe transitive dependency updates remove the currently reported npm audit findings.

### Added

- `.github/dependabot.yml` — weekly npm dependency update PRs.

## [0.4.0] - 2026-06-17

### Added

- **Payroll / Lön integration** — coverage for the Fortnox salary API, now that the **Lön** permission is grantable to integrations:
  - **Employees** — `noxctl employees list|get|create|update` and `fortnox_list_employees` / `fortnox_get_employee` / `fortnox_create_employee` / `fortnox_update_employee`. `employees create` has `--employment-form` / `--personel-type` / `--salary-form` (and `--employment-date` / `--monthly-salary` / `--hourly-pay`) flags — set the first three so Fortnox can assign a company employment agreement, otherwise it rejects with a `ftgavtalid` error (the API client now surfaces a hint for this).
  - **Salary transactions** — `noxctl salary-transactions list|get|create|delete` and matching MCP tools (filterable by `--employee` / `--date`).
  - **Attendance transactions** (närvaro) — `noxctl attendance-transactions list|get|create|delete` and MCP tools.
  - **Absence transactions** (frånvaro) — `noxctl absence-transactions list|get|create|delete` and MCP tools.
  - **Schedule times** (schematider) — `noxctl schedule-times get|update|reset-day` and MCP tools.
- **Opt-in `salary` scope** — the Lön scope is **not** requested by default (it would break `init` for apps without the Lön permission). Enable it with `noxctl init --with-salary` (or `FORTNOX_WITH_SALARY=1` for non-interactive runs). The granted scope set is persisted per-profile so the client-credentials refresh re-requests it, and `noxctl doctor` / `fortnox_status` probe it only when it was granted. **Existing installs must re-run `noxctl init --with-salary` to use the payroll commands.**

### Fixed

- `fortnox_status` (MCP) now probes the `payment` scope, matching the CLI `doctor` command.

### Changed

- **API drift detection no longer commits Fortnox's OpenAPI spec** to the repo. It now stores only opaque per-endpoint/per-schema hashes in `api-spec/openapi-fingerprint.json` (the full spec is fetched on demand into a git-ignored cache), avoiding redistribution of Fortnox's call structure (Developer Agreement cl. 6.1/6.3). New `npm run check:api` script.
- README/PRIVACY document the user's responsibilities under Fortnox's Developer Agreement (Swedish-company eligibility cl. 5.1, processor/DPA for third-party use cl. 12.3, and personal-data responsibility when sending Lön/ROT-RUT data to AI/LLMs cl. 13.5).

### Notes

- Absence transaction `Hours` / `Extent` are sent as numbers (matching the Fortnox spec), unlike the string-typed `Hours` on attendance/schedule resources.

## [0.3.0] - 2026-06-16

### Added

- **Voucher file attachments** (#37) — `noxctl vouchers attach <series> <number> <file...> [--year]` uploads receipt/underlag files to the Fortnox inbox and links them to a voucher; matching `fortnox_attach_voucher_files` MCP tool. The financial year is resolved from the voucher's transaction date when `--year` is omitted. Requires the **Inbox** and **Koppla filer** permissions (`inbox` + `connectfile` scopes) on your Fortnox app — **existing installs must re-run `noxctl init` to pick up the new scopes.** Also delivers the file-attachments half of #13.
- **Contracts API** (#10) — recurring invoicing: `noxctl contracts list|get|create|update|finish|create-invoice|increase-invoice-count` and matching MCP tools.
- **Financial years / locked period** (#11) — `noxctl financial-years list|get|locked-period` and MCP tools; context for period-aware operations.
- **Analytics views** (#7) — overdue summary, unpaid totals, top customers, VAT summary with net VAT position: `noxctl analytics ...` and MCP tools.
- **`noxctl dashboard`** (#12) — at-a-glance outstanding/overdue/recent invoices/monthly revenue.
- **Natural date periods** (#9) — `--period Q1|2025-Q3|march|mars|last-quarter|ytd|...` on list/report commands (calendar-year based; fiscal-year awareness deferred).
- **Shell completions** (#8) — `noxctl completion bash|zsh|fish`.
- **Confirmation payload preview** (#6) — the y/N prompt now shows the exact JSON payload that will be sent.
- **JSON error envelope** (#32) — in JSON mode, failures are emitted to stderr as `{"error": {status?, message, hint?, source}}`.
- **YubiKey serial diagnostics** (#33) — `keychain init` records the enrolled key's serial; `unlock` preflights it against `ykman list --serials` and names both serials on mismatch. ykman's misleading "empty slot"/"Failed to write" errors are translated.

### Changed

- **Stable JSON envelopes for single-resource output** (#34) — `get`/`create`/`update`/action commands now wrap their JSON output under the singular resource key (`{"Invoice": {...}}`), matching the list convention. Scripts that consumed the bare object should unwrap one level.
- The `-o` help text documents the default output mode (table on TTY, JSON when piped) (#34).

### Fixed

- `customers create`/`update` strip the server-derived read-only fields `Country`, `DeliveryCountry`, `VisitingCountry`, so a `customers get` response can be fed back into create/update unchanged (#31).

## [0.2.0] - 2026-04-20

### Added

- **Multi-profile support** — run noxctl against multiple Fortnox tenants from a single installation. Each profile has its own namespaced OAuth credentials in the OS secure store.
- **Profile resolution precedence:** `--profile <name>` flag → `NOXCTL_PROFILE` env var → `~/.fortnox-mcp/active-profile` pointer → `default`.
- **`noxctl profile` subcommands:** `use <name>`, `current`, `list`.
- **`--profile <name>` flag** on all commands, including `init` and `serve`.
- **MCP server startup profile binding** — the MCP server now resolves the profile at startup (from env + active pointer, or the forwarded CLI flag) and binds it for the session. Non-default sessions print a `[profile: <name>]` stderr banner.
- **Profile-tagged errors** — Fortnox API errors (`FortnoxApiError`) and runtime token-acquisition failures (`refreshAccessToken`, `getTokenViaClientCredentials`, `getValidToken`) are prefixed with `[profile: <name>]` when non-default, so mis-bound MCP sessions are diagnosable from a single line.
- **`MIGRATION.md`** covering the 0.1 → 0.2 upgrade path.

### Changed

- **Fail-closed pointer semantics at MCP startup.** `noxctl serve` refuses to start when the active-profile pointer is corrupt, unreadable, or times out and no `--profile` flag or `NOXCTL_PROFILE` is set. Exits with code 2 and a stderr message pointing at `noxctl doctor`. The CLI's `doctor` and `profile use` commands remain usable against a broken pointer so it can be repaired.
- **Pointer read uses `AbortController`** instead of `Promise.race`, so a timeout actually cancels the underlying `fs.readFile` rather than letting it run to completion in the background.
- **Credential storage is now namespaced by profile.** Existing 0.1.x installs are dual-read transparently (legacy entry → `default` profile) and the profile index is seeded on first observation. The new namespaced entry is written lazily on the next credential save (token refresh or `noxctl init`); the legacy entry stays dual-written for one release cycle so rollback to 0.1.x continues to work.

### Security

- Corrupt or ambiguous profile state no longer silently routes requests to the `default` tenant. This removes a wrong-tenant routing risk that existed implicitly in 0.1.x (where there was only one tenant, so the risk was vacuous — but the code path didn't enforce it).

## [0.1.0] - 2026-03-20

### Added

- Initial release.
- CLI and MCP server for Fortnox covering: customers, suppliers, articles, invoices, invoice payments, supplier invoices, supplier invoice payments, offers, orders, bookkeeping (vouchers, accounts), financial reports (income statement, balance sheet), tax (VAT summary, ROT/RUT tax reductions), projects, cost centers, price lists, prices, and company info.
- Interactive `noxctl init` setup wizard with OAuth2 authorization-code and client-credentials (service account) flows.
- Secure credential storage in the OS keychain (macOS Keychain, Linux Secret Service, Windows DPAPI).
- Mutation safety: TTY confirmation prompts, `--yes` / `confirm: true` for scripting, `--dry-run` / `dryRun` for previews.
- Table and JSON output modes (auto-detected by TTY, override with `-o`).
- `noxctl doctor` / `fortnox_status` for setup validation.

[0.4.1]: https://github.com/Magnus-Gille/noxctl/compare/v0.4.0...v0.4.1
[0.2.0]: https://github.com/Magnus-Gille/noxctl/releases/tag/v0.2.0
[0.1.0]: https://github.com/Magnus-Gille/noxctl/releases/tag/v0.1.0
