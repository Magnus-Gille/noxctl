# noxctl

MCP server for Fortnox — manage invoices, customers, bookkeeping, and VAT directly from Claude Code.

## Quick start

### From npm

```bash
FORTNOX_CLIENT_ID=<your-id> FORTNOX_CLIENT_SECRET=<your-secret> npx noxctl setup

claude mcp add fortnox -- npx noxctl serve
```

### From source

```bash
git clone https://github.com/Magnus-Gille/noxctl.git
cd noxctl
npm install
npm run build

FORTNOX_CLIENT_ID=<your-id> FORTNOX_CLIENT_SECRET=<your-secret> node dist/cli.js setup

claude mcp add fortnox -- node /absolute/path/to/noxctl/dist/cli.js serve
```

Done. No manual tokens, no environment variables after setup.

## Prerequisites

- **Node.js** 20+
- **Fortnox account** with API access (Mellan plan or higher)
- **Fortnox app** registered at [developer.fortnox.se](https://developer.fortnox.se/) with redirect URI `http://localhost:9876/callback`
- **Linux only:** `secret-tool` available for secure credential storage

## Setup

### 1. Create a Fortnox app

1. Go to [developer.fortnox.se](https://developer.fortnox.se/)
2. Create a new app
3. Set redirect URI to `http://localhost:9876/callback`
4. Note your Client ID and Client Secret
5. Request scopes: `customer`, `invoice`, `bookkeeping`, `companyinformation`, `settings`
6. Enable "Service account" if you want to use the client credentials flow (recommended)

### 2. Authenticate

```bash
FORTNOX_CLIENT_ID=<your-id> FORTNOX_CLIENT_SECRET=<your-secret> npx noxctl setup
```

To enable the client credentials flow (recommended if you have service accounts enabled in the Developer Portal):

```bash
FORTNOX_CLIENT_ID=<your-id> FORTNOX_CLIENT_SECRET=<your-secret> FORTNOX_SERVICE_ACCOUNT=1 npx noxctl setup
```

This opens your browser to log in to Fortnox. After authorization, credentials are stored in the OS secure store:

- **macOS:** Keychain (`security`)
- **Linux:** Secret Service via `secret-tool`
- **Windows:** DPAPI-protected user store

Legacy plaintext `~/.fortnox-mcp/credentials.json` files are read for migration only and removed on the next successful save.

Token management is automatic:
- **With service account (`FORTNOX_SERVICE_ACCOUNT=1`):** Uses client credentials flow with `TenantId` — no refresh tokens to manage. The tenant ID is fetched automatically during setup.
- **Without service account (default):** Uses standard OAuth2 refresh token flow.

### 3. Register with Claude Code

```bash
claude mcp add fortnox -- npx noxctl serve
```

If you are running from a local clone instead of npm:

```bash
claude mcp add fortnox -- node /absolute/path/to/noxctl/dist/cli.js serve
```

## Tools

### Customers

| Tool | Description |
|------|-------------|
| `fortnox_list_customers` | List/search customers |
| `fortnox_get_customer` | Get a single customer |
| `fortnox_create_customer` | Create a new customer |
| `fortnox_update_customer` | Update an existing customer |

### Invoices

| Tool | Description |
|------|-------------|
| `fortnox_list_invoices` | List/filter invoices |
| `fortnox_get_invoice` | Get a single invoice |
| `fortnox_create_invoice` | Create an invoice |
| `fortnox_send_invoice` | Send invoice via email, print, or e-invoice |
| `fortnox_bookkeep_invoice` | Book an invoice |
| `fortnox_credit_invoice` | Credit an invoice |

### Bookkeeping

| Tool | Description |
|------|-------------|
| `fortnox_list_vouchers` | List vouchers |
| `fortnox_create_voucher` | Create a voucher |
| `fortnox_list_accounts` | View chart of accounts |

### Tax

| Tool | Description |
|------|-------------|
| `fortnox_tax_report` | VAT summary for a period (tax declaration support) |

### Company

| Tool | Description |
|------|-------------|
| `fortnox_company_info` | Company information and settings |

## CLI output

By default, `noxctl` uses **table output** on interactive terminals and **JSON** when piped or redirected. Override with `-o`:

```bash
noxctl invoices list              # table on terminal, JSON when piped
noxctl -o json invoices list      # force JSON
noxctl -o table invoices list     # force table
noxctl invoices list | jq .       # auto-JSON (piped)
```

When running from a local clone instead of an installed binary, replace `noxctl` with `node dist/cli.js`.

## Mutation safety

Mutating commands now require explicit confirmation.

CLI:

```bash
noxctl invoices send 1001 --dry-run
noxctl invoices send 1001 --yes
noxctl customers update 42 --input customer.json --yes
noxctl vouchers create --input voucher.json --dry-run
```

MCP tools:

- Mutating tools require `confirm: true`
- Use `dryRun: true` to preview a request without sending it
- Raw Fortnox JSON is opt-in via `includeRaw: true`

## Examples

Ask Claude naturally:

- "Skapa en faktura till kund 42 för 10 konsulttimmar á 1200 kr"
- "Visa alla obetalda fakturor"
- "Vad har vi för utgående moms Q1 2025?"
- "Bokför kontorsmaterial för 1250 kr inkl moms"
- "Skicka faktura 1001 via e-post"

## Development

```bash
npm install
npm run build        # compile TypeScript
npm test             # run tests
npm run test:watch   # watch mode
npm run lint         # currently requires adding eslint.config.js for ESLint 10
npm run format       # format
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## Security

- Credentials stored in the OS secure store, not plaintext repo or home-directory JSON
- No secrets in environment variables after initial setup
- OAuth callback is bound to loopback and validated with a per-run OAuth `state`
- OAuth/client-credentials secrets are never emitted in tool responses
- Mutating actions require explicit confirmation or `dryRun`
- MCP responses are summarized by default; raw Fortnox JSON is opt-in
- Retries are limited to idempotent requests

## License

MIT
