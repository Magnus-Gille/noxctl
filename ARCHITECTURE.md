# Architecture

## Overview

```
src/
├── cli.ts                  # CLI entry point (Commander): init, doctor, logout, serve, resource subcommands
├── index.ts                # MCP server creation and startup (stdio)
├── embedded.ts             # Supported tenant-bound package API for host applications
├── auth.ts                 # OAuth2: setup flow, token exchange, refresh, service-account mode
├── credentials-store.ts    # OS keychain (macOS Security / Linux secret-tool / Windows DPAPI)
├── fortnox-client.ts       # HTTP client: rate limiting, retry, endpoint→scope error hints
├── formatter.ts            # Table/JSON output rendering
├── tool-output.ts          # Shared MCP tool response formatting
├── views.ts                # Column definitions for list/detail/confirm views
├── identifiers.ts          # Shared Zod types for identifiers
├── operations/             # Transport-bound Fortnox API calls (shared by CLI and MCP)
│   ├── index.ts                       # Builds one complete operation set per transport
│   ├── accounts.ts                    articles.ts            company.ts
│   ├── costcenters.ts                 customers.ts           financial-reports.ts
│   ├── invoices.ts                    invoice-payments.ts    offers.ts
│   ├── orders.ts                      pricelists.ts          projects.ts
│   ├── supplier-invoices.ts           supplier-invoice-payments.ts
│   ├── suppliers.ts                   tax.ts                 taxreductions.ts
│   └── vouchers.ts
└── tools/                  # MCP tool registrations (Zod schemas, Swedish descriptions)
    ├── articles.ts                    bookkeeping.ts         company.ts
    ├── costcenters.ts                 customers.ts           financial-reports.ts
    ├── invoices.ts                    invoice-payments.ts    offers.ts
    ├── orders.ts                      pricelists.ts          projects.ts
    ├── status.ts                      supplier-invoices.ts   supplier-invoice-payments.ts
    ├── suppliers.ts                   tax.ts                 taxreductions.ts
    └── (vouchers + accounts live in bookkeeping.ts)
```

Each resource pairs an `operations/<name>.ts` module (API calls bound to an explicit `FortnoxTransport`) with a `tools/<name>.ts` module (MCP registration with Zod schemas). Backward-compatible default exports bind to the local profile transport. CLI subcommands in `cli.ts` mirror the MCP tools 1:1.

## Key design decisions

### stdio transport

The server runs locally via stdio — no HTTP server to host or manage. Claude Code spawns `noxctl serve` as a child process and communicates over stdin/stdout.

### Embedded tenant boundary

Host applications import `noxctl/embedded`, create one `FortnoxTransport` from trusted server-side authorization state, and pass it to `createServer({ transport })` or `createFortnoxOperations(transport)`. Token lookup, diagnostic context, request queue, and rate-limit state belong to that transport instance. MCP tool arguments cannot choose tenant, profile, or token routing.

The local `fortnox_status` tool is omitted from embedded servers because it inspects the host process's profile/keychain. `createServer()` without arguments preserves local behavior. OAuth, token storage, sessions, billing, deployment, and operational controls remain the host's responsibility; see [docs/embedded.md](docs/embedded.md).

### OAuth2 setup flow

`noxctl init` starts a temporary local HTTP server on port 9876, binds it to `127.0.0.1`, opens the browser for Fortnox login, validates a per-run OAuth `state`, receives the callback, exchanges the code for tokens, saves them, and exits. After this one-time setup, no environment variables are needed.

### Token management

Credentials (client ID, client secret, access token, refresh token, expiry) are stored in the OS secure store:

- macOS Keychain
- Linux Secret Service (`secret-tool`)
- Windows DPAPI user-protected storage

Legacy plaintext `~/.fortnox-mcp/credentials.json` files are migration-only and removed on the next successful save. On every API call, `getValidToken()` checks expiry and transparently refreshes if needed.

### Rate limiting

Fortnox allows 25 requests per 5 seconds. Each client instance tracks its own timestamps and waits if the limit would be exceeded — requests queue rather than fail, and two tenant clients do not share limiter state.

### Retry with backoff

Transient errors (429, 5xx, network errors) are retried up to 3 times with exponential backoff (1s, 2s, 4s), but only for idempotent requests (`GET`/`HEAD`/`OPTIONS`). Non-idempotent mutations fail immediately to avoid duplicate side effects.

### Mutation confirmation

Mutating CLI commands require `--yes` or an interactive TTY confirmation and support `--dry-run`. Mutating MCP tools require `confirm: true` and support `dryRun: true`.

### Privacy minimization

MCP tools return summarized views by default (tables/details over selected fields). Raw Fortnox JSON is opt-in via `includeRaw: true`, and the raw path should be treated as higher-risk because it can expose more accounting and personal data to AI transcripts, logs, and terminals.

### Error handling

Fortnox API errors are parsed into `FortnoxApiError` with the Fortnox error message and code. The MCP SDK surfaces these as tool errors that Claude can understand and communicate to the user.

## Testing strategy

- **Unit tests** (`tests/auth.test.ts`, `tests/fortnox-client.test.ts`): mock `fs` and `fetch` to test auth and HTTP client logic in isolation.
- **Integration tests** (`tests/tools/*.test.ts`): use `InMemoryTransport` to create a real MCP client-server pair, mock only the HTTP layer. This tests the full tool registration, schema validation, and response formatting.
- **Package consumer gate** (`scripts/check-embedded-consumer.mjs`): packs the real npm tarball, imports `noxctl/embedded` from an isolated consumer, and type-checks its supported API.

## Data flow

```
Local:
Claude Code ──stdio──> MCP Server ──operations──> local FortnoxTransport ──HTTP──> Fortnox API
                                                       │
                                                       └── auth.ts / OS keychain

Embedded:
Host session ──> createServer({ transport }) ──operations──> tenant FortnoxTransport ──HTTP──> Fortnox API
                  (tenant already authorized)                 (instance-owned state)
```
