# Architecture

## Overview

```
src/
├── cli.ts              # Entry point: setup wizard or MCP server
├── index.ts            # MCP server creation and startup
├── auth.ts             # OAuth2: setup flow, token exchange, refresh, storage
├── fortnox-client.ts   # HTTP client: rate limiting, retry, error handling
└── tools/
    ├── customers.ts    # Customer CRUD (4 tools)
    ├── invoices.ts     # Invoice lifecycle (6 tools)
    ├── bookkeeping.ts  # Vouchers + chart of accounts (3 tools)
    ├── tax.ts          # VAT report (1 tool)
    └── company.ts      # Company info (1 tool)
```

## Key design decisions

### stdio transport

The server runs locally via stdio — no HTTP server to host or manage. Claude Code spawns `noxctl serve` as a child process and communicates over stdin/stdout.

### OAuth2 setup flow

`noxctl setup` starts a temporary local HTTP server on port 9876, opens the browser for Fortnox login, receives the OAuth callback, exchanges the code for tokens, saves them, and exits. After this one-time setup, no environment variables are needed.

### Token management

Credentials (client ID, client secret, access token, refresh token, expiry) are stored in `~/.fortnox-mcp/credentials.json` with mode 0600. On every API call, `getValidToken()` checks expiry and transparently refreshes if needed.

### Rate limiting

Fortnox allows 25 requests per 5 seconds. The client tracks timestamps and waits if the limit would be exceeded — requests queue rather than fail.

### Retry with backoff

Transient errors (429, 5xx, network errors) are retried up to 3 times with exponential backoff (1s, 2s, 4s). Non-transient errors (4xx) fail immediately.

### Error handling

Fortnox API errors are parsed into `FortnoxApiError` with the Fortnox error message and code. The MCP SDK surfaces these as tool errors that Claude can understand and communicate to the user.

## Testing strategy

- **Unit tests** (`tests/auth.test.ts`, `tests/fortnox-client.test.ts`): mock `fs` and `fetch` to test auth and HTTP client logic in isolation.
- **Integration tests** (`tests/tools/*.test.ts`): use `InMemoryTransport` to create a real MCP client-server pair, mock only the HTTP layer. This tests the full tool registration, schema validation, and response formatting.

## Data flow

```
Claude Code ──stdio──> MCP Server ──HTTP──> Fortnox API
                         │
                         ├── auth.ts (token management)
                         ├── fortnox-client.ts (rate limit, retry)
                         └── tools/*.ts (business logic)
```
