# fortnox-mcp

MCP server for Fortnox — manage invoices, customers, bookkeeping, and VAT directly from Claude Code.

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/Magnus-Gille/fortnox-mcp.git
cd fortnox-mcp
npm install && npm run build

# 2. Connect to Fortnox (opens browser for OAuth)
FORTNOX_CLIENT_ID=<your-id> FORTNOX_CLIENT_SECRET=<your-secret> noxctl setup

# 3. Register in Claude Code
claude mcp add fortnox -- noxctl serve
```

Done. No manual tokens, no environment variables after setup.

## Prerequisites

- **Node.js** 20+
- **Fortnox account** with API access (Mellan plan or higher)
- **Fortnox app** registered at [developer.fortnox.se](https://developer.fortnox.se/) with redirect URI `http://localhost:9876/callback`

## Setup

### 1. Create a Fortnox app

1. Go to [developer.fortnox.se](https://developer.fortnox.se/)
2. Create a new app
3. Set redirect URI to `http://localhost:9876/callback`
4. Note your Client ID and Client Secret
5. Request scopes: `customer`, `invoice`, `bookkeeping`, `companyinformation`

### 2. Authenticate

```bash
FORTNOX_CLIENT_ID=<your-id> FORTNOX_CLIENT_SECRET=<your-secret> noxctl setup
```

This opens your browser to log in to Fortnox. After authorization, credentials are saved locally to `~/.fortnox-mcp/credentials.json` (mode 0600). Token refresh is automatic.

### 3. Register with Claude Code

```bash
claude mcp add fortnox -- noxctl serve
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
npm run lint         # lint
npm run format       # format
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## Security

- Credentials stored locally with restricted file permissions (0600)
- No secrets in environment variables after initial setup
- OAuth2 with automatic token refresh
- No external dependencies beyond the Fortnox API
- Rate limiting and retry built in

## License

MIT
