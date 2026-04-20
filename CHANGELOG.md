# Changelog

All notable changes to noxctl are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-20

### Added

- **Multi-profile support** — run noxctl against multiple Fortnox tenants from a single installation. Each profile has its own namespaced OAuth credentials in the OS keychain.
- **Profile resolution precedence:** `--profile <name>` flag → `NOXCTL_PROFILE` env var → `~/.fortnox-mcp/active-profile` pointer → `default`.
- **`noxctl profile` subcommands:** `use <name>`, `current`, `list`.
- **`--profile <name>` flag** on all commands, including `init` and `serve`.
- **MCP server startup profile binding** — the MCP server now resolves the profile at startup (from env + active pointer, or the forwarded CLI flag) and binds it for the session. Non-default sessions print a `[profile: <name>]` stderr banner.
- **Profile-tagged errors** — Fortnox API errors (`FortnoxApiError`) and runtime token-acquisition failures (`refreshAccessToken`, `getTokenViaClientCredentials`, `getValidToken`) are prefixed with `[profile: <name>]` when non-default, so mis-bound MCP sessions are diagnosable from a single line.
- **`MIGRATION.md`** covering the 0.1 → 0.2 upgrade path.

### Changed

- **Fail-closed pointer semantics at MCP startup.** `noxctl serve` refuses to start when the active-profile pointer is corrupt, unreadable, or times out and no `--profile` flag or `NOXCTL_PROFILE` is set. Exits with code 2 and a stderr message pointing at `noxctl doctor`. The CLI's `doctor` and `profile use` commands remain usable against a broken pointer so it can be repaired.
- **Pointer read uses `AbortController`** instead of `Promise.race`, so a timeout actually cancels the underlying `fs.readFile` rather than letting it run to completion in the background.
- **Credential storage is now namespaced by profile.** A one-time migration on first run re-writes existing credentials under the `default` profile. The legacy entry is preserved for one release cycle to allow rollback to 0.1.x.

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

[0.2.0]: https://github.com/Magnus-Gille/noxctl/releases/tag/v0.2.0
[0.1.0]: https://github.com/Magnus-Gille/noxctl/releases/tag/v0.1.0
