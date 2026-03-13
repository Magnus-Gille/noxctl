# noxctl

CLI and MCP server for Fortnox — manage invoices, customers, bookkeeping, and VAT from the terminal or from AI agents like Claude Code.

```
noxctl init                          # interactive setup wizard
noxctl company info                  # verify connection
noxctl customers list                # list customers
noxctl invoices list --filter unpaid # unpaid invoices
noxctl -o json invoices list | jq .  # JSON output for scripting/AI
```

## Prerequisites

- **Node.js** 20+
- **Fortnox account** with API access (Mellan plan or higher)
- **Linux only:** `secret-tool` available for secure credential storage

## Setup

### 1. Create a Fortnox app

> **Tip:** Run `npx noxctl init` for an interactive setup wizard that guides you through all of these steps.

1. Go to [developer.fortnox.se](https://developer.fortnox.se/) and click **Integrationer** / **Integrations**
2. Create a new app (integration)
3. On the **OAuth** tab:
   - Set **Redirect URI** to `http://localhost:9876/callback`
   - Check **"Möjliggör auktorisering som servicekonto"** / **"Enable service account authorization"** (recommended)
   - Copy your **Client ID** and **Client Secret**
4. On the **Integration** tab, enable these scopes under **Behörigheter** / **Permissions**:

   | Swedish (SV)         | English (EN)        |
   |----------------------|---------------------|
   | Bokföring            | Bookkeeping         |
   | Faktura              | Invoice             |
   | Företagsinformation  | Company Information |
   | Inställningar        | Settings            |
   | Kund                 | Customer            |

5. Save the integration

### 2. Authenticate

Set your credentials as environment variables, then run setup:

```bash
export FORTNOX_CLIENT_ID=<your-id>
export FORTNOX_CLIENT_SECRET=<your-secret>
export FORTNOX_SERVICE_ACCOUNT=1
npx noxctl setup
```

> Drop the `FORTNOX_SERVICE_ACCOUNT` line if you did not enable service account authorization in step 1.

If running from a local clone instead of npm:

```bash
export FORTNOX_CLIENT_ID=<your-id>
export FORTNOX_CLIENT_SECRET=<your-secret>
export FORTNOX_SERVICE_ACCOUNT=1
npm run build
node dist/cli.js setup
```

This opens your browser to log in to Fortnox. After authorization, credentials are stored in the OS secure store:

- **macOS:** Keychain (`security`)
- **Linux:** Secret Service via `secret-tool`
- **Windows:** DPAPI-protected user store

Token management is automatic after setup — no environment variables needed going forward.

- **With service account:** Uses client credentials flow with `TenantId` — no refresh tokens to manage. The tenant ID is fetched automatically during setup.
- **Without service account (default):** Uses standard OAuth2 refresh token flow.

### 3. Register with Claude Code

```bash
claude mcp add fortnox -- npx noxctl serve
```

If you are running from a local clone instead of npm:

```bash
claude mcp add fortnox -- node /absolute/path/to/noxctl/dist/cli.js serve
```

### 4. Verify the connection

```bash
noxctl company info
```

If running from source:

```bash
node dist/cli.js company info
```

You should see your company name, organisation number, and address. If this works, you're all set.

## Tools

Every operation is available both as a CLI command and as an MCP tool. The CLI is the primary interface; the MCP server exposes the same operations to AI agents.

### Customers

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl customers list [--search <term>]` | `fortnox_list_customers` | List/search customers |
| `noxctl customers get <number>` | `fortnox_get_customer` | Get a single customer by customer number |
| `noxctl customers create --name <name>` | `fortnox_create_customer` | Create a new customer (mutation) |
| `noxctl customers update <number> --input <file>` | `fortnox_update_customer` | Update an existing customer (mutation) |

### Invoices

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl invoices list [--filter <status>] [--customer <number>]` | `fortnox_list_invoices` | List/filter invoices. Filters: `cancelled`, `fullypaid`, `unpaid`, `unpaidoverdue`, `unbooked` |
| `noxctl invoices get <docNumber>` | `fortnox_get_invoice` | Get a single invoice by document number |
| `noxctl invoices create --customer <number> --input <file>` | `fortnox_create_invoice` | Create an invoice with line items (mutation) |
| `noxctl invoices send <docNumber> [--method email\|print\|einvoice]` | `fortnox_send_invoice` | Send invoice via email (default), print, or e-invoice (mutation) |
| `noxctl invoices bookkeep <docNumber>` | `fortnox_bookkeep_invoice` | Book an invoice (mutation) |
| `noxctl invoices credit <docNumber>` | `fortnox_credit_invoice` | Credit an invoice (mutation) |

### Bookkeeping

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl vouchers list [--series <s>] [--from <date>] [--to <date>]` | `fortnox_list_vouchers` | List vouchers, optionally filtered by series and date range |
| `noxctl vouchers create --input <file>` | `fortnox_create_voucher` | Create a voucher with debit/credit rows (mutation) |
| `noxctl accounts list [--search <term>]` | `fortnox_list_accounts` | View chart of accounts, search by name or number |

### Tax

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl tax report --from <date> --to <date>` | `fortnox_tax_report` | VAT summary for a period (tax declaration support). Dates in `YYYY-MM-DD` format |

### Company

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl company info` | `fortnox_company_info` | Company name, org number, address, and settings |

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

Ask Claude naturally — works in both Swedish and English:

- "Skapa en faktura till kund 42 för 10 konsulttimmar á 1200 kr"
- "Create an invoice for customer 42: 10 consulting hours at 1200 SEK"
- "Visa alla obetalda fakturor" / "Show all unpaid invoices"
- "Vad har vi för utgående moms Q1 2025?" / "What's our outgoing VAT for Q1 2025?"
- "Bokför kontorsmaterial för 1250 kr inkl moms" / "Book office supplies for 1250 SEK incl VAT"
- "Skicka faktura 1001 via e-post" / "Send invoice 1001 by email"

## Troubleshooting

**"FORTNOX_CLIENT_ID and FORTNOX_CLIENT_SECRET must be set"**

Environment variables were not passed to the command. Use `export` to set them in your shell first:

```bash
export FORTNOX_CLIENT_ID=<your-id>
export FORTNOX_CLIENT_SECRET=<your-secret>
```

Then run setup again. This avoids issues with long commands wrapping across lines.

**"Not authenticated. Run `noxctl setup`"**

Credentials are missing or were not saved. Re-run the setup step. On macOS, check that Keychain Access is not blocking the `security` command. On Linux, ensure `secret-tool` is installed (`sudo apt install libsecret-tools`).

**403 Forbidden from Fortnox API**

Your app is missing required scopes. Go to [developer.fortnox.se](https://developer.fortnox.se/), open your app, and check that these are enabled under **Behörigheter** / **Permissions**:

| Swedish (SV)         | English (EN)        |
|----------------------|---------------------|
| Bokföring            | Bookkeeping         |
| Faktura              | Invoice             |
| Företagsinformation  | Company Information |
| Inställningar        | Settings            |
| Kund                 | Customer            |

**"Token refresh failed"**

Your refresh token may have expired or been revoked. Re-run setup to re-authenticate.

**Port 9876 already in use**

Another process is using the OAuth callback port. Close it or wait for a previous setup attempt to finish, then try again.

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
