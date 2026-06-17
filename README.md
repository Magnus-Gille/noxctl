# noxctl

Command-line interface (CLI) and Model Context Protocol (MCP) server for Fortnox — manage invoices, customers, bookkeeping, and VAT (Value Added Tax) from the terminal or from AI (Artificial Intelligence) agents like Claude Code.

```
noxctl init                          # interactive setup wizard
noxctl company info                  # verify connection
noxctl customers list                # list customers
noxctl invoices list --filter unpaid # unpaid invoices
noxctl -o json invoices list | jq .  # JSON output for scripting/AI
```

## Status

noxctl is an independent, **unofficial** open-source project. It is **not affiliated with, endorsed by, or certified by Fortnox AB.**

Use it with your own Fortnox account and developer credentials. **It is provided "as is", with no warranty and no liability — the author takes no responsibility for anything you do with it; you use it entirely at your own risk and are responsible for complying with Fortnox terms, Swedish bookkeeping/tax/payroll rules, and your own privacy obligations.** See the full [Disclaimer](#disclaimer).

## Prerequisites

- **Node.js** 20+
- **Fortnox account** with API (Application Programming Interface) access
- **Your own Fortnox developer app** with the required scopes enabled
- **Linux only:** `secret-tool` available for secure credential storage

Fortnox product plans, API activation requirements, and integration licensing can change. Verify the current Fortnox requirements before publishing or relying on this setup for business-critical work.

## Setup

### How it connects to Fortnox

noxctl is a thin client over the **Fortnox REST API (v3)** at `https://api.fortnox.se/3`. It uses a **bring-your-own-app** model — there is no shared backend and no middleman:

1. **You** create a Fortnox developer app (integration) and pick its permissions (scopes).
2. **You** authorize that app against your own Fortnox company over OAuth2 (`noxctl init`).
3. noxctl stores the resulting token in your OS keychain and calls the Fortnox API **directly from your machine** — nothing is proxied through any server operated by the author.

So you control the credentials, the scopes, and which company is connected end to end. The three steps below set this up.

### 1. Create a Fortnox app

> **Tip:** Run `npx noxctl init` (npx is a tool included with npm, the Node Package Manager) for an interactive setup wizard that guides you through all of these steps.

1. Go to [developer.fortnox.se](https://developer.fortnox.se/) and click **Integrationer** / **Integrations**
2. Create a new app (integration)
3. On the **OAuth (Open Authorization)** tab:
   - Set **Redirect URI (Uniform Resource Identifier)** to `http://localhost:9876/callback`
   - Check **"Möjliggör auktorisering som servicekonto"** / **"Enable service account authorization"** (recommended)
   - Copy your **Client ID** and **Client Secret**
4. On the **Integration** tab, enable these scopes under **Behörigheter** / **Permissions**:

   | Swedish (SV)         | English (EN)        | Needed for                                     |
   |----------------------|---------------------|------------------------------------------------|
   | Artikel              | Article             | Articles, prices, price lists                  |
   | Bokföring            | Bookkeeping         | Vouchers, accounts, financial reports          |
   | Faktura              | Invoice             | Invoices, invoice payments, offers, orders, tax reductions |
   | Företagsinformation  | Company Information | Company info                                   |
   | Inställningar        | Settings            | Financial year, locked period                  |
   | Kund                 | Customer            | Customers                                      |
   | Leverantör           | Supplier            | Suppliers                                      |
   | Leverantörsfaktura   | Supplier Invoice    | Supplier invoices, supplier invoice payments   |
   | Projekt              | Project             | Projects                                       |
   | Kostnadsställe       | Cost Center         | Cost centers                                   |
   | Priser               | Price               | Price lists, prices                            |
   | Lön                  | Salary              | Payroll: employees, salary/attendance/absence transactions, schedule times — **opt-in**, see below |

   Enable every scope for the resources you intend to use. Missing scopes surface as `403 Forbidden` with a hint pointing at the right one.

   **Payroll (Lön) is opt-in.** The `salary` scope is *not* requested by default, because requesting a scope your app hasn't been granted breaks authorization. To use the payroll commands, enable the **Lön** permission above, then authorize with `noxctl init --with-salary` (or set `FORTNOX_WITH_SALARY=1` for non-interactive setups). The granted scope set is remembered per profile, so token refreshes keep working.

5. Save the integration

You are creating and authorizing your own Fortnox app here. noxctl does not ship shared Fortnox credentials and does not bypass Fortnox's authorization model.

### 2. Authenticate

Run the interactive setup wizard:

```bash
npx noxctl init
```

If running from a local clone:

```bash
npm run build
node dist/cli.js init
```

The wizard will prompt for your Client ID and Client Secret (masked input), run the OAuth flow, verify the connection, and optionally register the MCP server with Claude Code.

After authorization, credentials are stored in the OS (Operating System) secure store:

- **macOS:** Keychain (`security`)
- **Linux:** Secret Service via `secret-tool`
- **Windows:** DPAPI (Data Protection API)-protected user store

Token management is automatic after setup — no environment variables needed going forward.

- **With service account:** Uses client credentials flow with `TenantId` — no refresh tokens to manage. The tenant ID is fetched automatically during setup.
- **Without service account (default):** Uses standard OAuth2 refresh token flow.

### 3. Register as MCP server (optional — for Claude Desktop/Web)

If you use Claude Desktop or claude.ai, register the MCP server so those environments can access Fortnox. Claude Code can use the CLI directly, so this step is optional there.

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

## Profiles (multi-tenant)

noxctl supports multiple Fortnox tenants from a single installation — useful if you bookkeep for several companies, or want to keep a sandbox tenant separate from production. Each profile has its own OAuth credentials in the OS secure store (macOS Keychain / Linux Secret Service / Windows DPAPI), keyed by profile name.

### Running against a specific profile

Three ways to pick the profile, in precedence order (highest wins):

1. **`--profile <name>` flag** — explicit, per-command
2. **`NOXCTL_PROFILE` environment variable** — scoped to a shell session
3. **Active pointer** — `~/.fortnox-mcp/active-profile`, set by `noxctl profile use`

If none of these is set, noxctl uses the `default` profile (what existing users have been using all along — no opt-in required).

```bash
noxctl init --profile staging              # authorize a second tenant
noxctl --profile staging invoices list     # one-off against staging
NOXCTL_PROFILE=staging noxctl company info # shell-scoped
noxctl profile use staging                 # sticky — persists to the pointer
noxctl profile current                     # show resolved profile + source
noxctl profile list                        # list known profiles
```

### MCP server

When launched by Claude Desktop / claude.ai, the MCP server resolves the profile from `NOXCTL_PROFILE` and the active pointer at startup, and binds for the session. When launched via `noxctl --profile <name> serve`, the CLI forwards the flag.

To run multiple MCP servers (one per tenant) in parallel, register them with distinct names and scoped environments:

```bash
claude mcp add fortnox-prod     -- npx noxctl serve
claude mcp add fortnox-staging  -e NOXCTL_PROFILE=staging -- npx noxctl serve
```

Non-default sessions print a `[profile: <name>]` stderr banner on startup and prefix every Fortnox API error and token-refresh failure with the same tag so mis-bound sessions are diagnosable from a single error line.

### Fail-closed pointer semantics

If the active pointer becomes unreadable or corrupt and no explicit `--profile` flag or `NOXCTL_PROFILE` is set, `noxctl serve` **refuses to start** rather than silently falling back to `default`. This prevents a corrupted pointer from routing production MCP sessions to the wrong tenant. The CLI's `doctor` and `profile use` commands are exempt — they can still run against a broken pointer so you can repair it.

## YubiKey-locked keychain (macOS)

By default, credentials live in your macOS **login keychain**, which unlocks automatically when you log in. That's convenient, but it means an AI agent (or anything running as you) can read the tokens without a per-session gesture from you.

The optional **dedicated keychain** moves credentials into a separate, lock-on-sleep keychain whose password is derived from your YubiKey via HMAC-SHA1 challenge-response. You unlock it once per session with a single tap; it re-locks when your Mac sleeps. The keychain password is never typed or stored — it only exists on the YubiKey.

This is opt-in and macOS-only. It does not change how credentials are stored on Linux or Windows.

### One-time YubiKey setup

Program OTP slot 2 for challenge-response (requires touch). **This writes only the empty OTP slot 2** — FIDO2, PIV, OATH, OpenPGP, and slot 1 are untouched, and it is reversible with `ykman otp delete 2`.

```bash
brew install ykman                              # if not already installed
ykman otp chalresp --generate --touch 2         # program slot 2
```

### Enable it

```bash
noxctl keychain init      # generate challenge, tap to derive the password,
                          # create the locked keychain, copy existing creds in
```

`init` uses **copy-and-keep**: your existing login-keychain credentials are copied into the new keychain but left in place as a rollback. Once you've confirmed the new flow works, remove the originals:

```bash
noxctl keychain seal      # delete the login-keychain copies (irreversible)
```

Until you `seal`, the login copies remain readable without a tap — so the per-session protection isn't fully in effect.

### Daily use

```bash
noxctl keychain unlock    # tap your YubiKey — open until the Mac next sleeps
noxctl keychain status    # mode, lock state, ykman/YubiKey presence
noxctl keychain lock      # lock immediately
```

When the keychain is locked, any command that needs credentials fails fast with a message telling you to run `noxctl keychain unlock` — it never pops a macOS password dialog (the challenge-response password can't be typed into one).

### Recovery if you lose the YubiKey

The keychain password lives only on the key, so a lost or re-programmed key means the dedicated keychain can't be unlocked. As long as you have **not** run `seal`, your credentials are still in the login keychain — delete the dedicated keychain and challenge file to fall back:

```bash
security delete-keychain ~/Library/Keychains/fortnox-mcp.keychain-db
rm ~/.fortnox-mcp/keychain-challenge
```

If you *have* sealed, re-run `noxctl init` to re-authenticate from scratch.

## Tools

Every operation is available both as a CLI command and as an MCP tool. The CLI is the primary interface; the MCP server exposes the same operations to AI agents. All mutations — every row labeled `(mutation)` — prompt for confirmation on a TTY and require `--yes` (CLI) or `confirm: true` (MCP) when piped. See [Mutation safety](#mutation-safety).

### Customers

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl customers list [--search <term>]` | `fortnox_list_customers` | List/search customers |
| `noxctl customers get <number>` | `fortnox_get_customer` | Get a single customer |
| `noxctl customers create --name <name>` | `fortnox_create_customer` | Create a customer (mutation) |
| `noxctl customers update <number> --input <file>` | `fortnox_update_customer` | Update a customer (mutation) |

### Suppliers

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl suppliers list [--search <term>]` | `fortnox_list_suppliers` | List/search suppliers |
| `noxctl suppliers get <number>` | `fortnox_get_supplier` | Get a single supplier |
| `noxctl suppliers create --name <name>` | `fortnox_create_supplier` | Create a supplier (mutation) |
| `noxctl suppliers update <number> --input <file>` | `fortnox_update_supplier` | Update a supplier (mutation) |

### Articles

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl articles list [--search <term>]` | `fortnox_list_articles` | List/search articles |
| `noxctl articles get <number>` | `fortnox_get_article` | Get a single article |
| `noxctl articles create --description <text>` | `fortnox_create_article` | Create an article (mutation) |
| `noxctl articles update <number> --input <file>` | `fortnox_update_article` | Update an article (mutation) |

### Invoices

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl invoices list [--filter <status>] [--customer <number>]` | `fortnox_list_invoices` | List/filter invoices. Filters: `cancelled`, `fullypaid`, `unpaid`, `unpaidoverdue`, `unbooked` |
| `noxctl invoices get <docNumber>` | `fortnox_get_invoice` | Get a single invoice |
| `noxctl invoices create --customer <number> --input <file>` | `fortnox_create_invoice` | Create an invoice (mutation) |
| `noxctl invoices update <docNumber> --input <file>` | `fortnox_update_invoice` | Update an invoice that has not been bookkeept (mutation) |
| `noxctl invoices send <docNumber> [--method email\|print\|einvoice] [--subject <s>] [--body <s>] [--bcc <email>]` | `fortnox_send_invoice` | Send via email (default), print, or e-invoice (mutation) |
| `noxctl invoices bookkeep <docNumber>` | `fortnox_bookkeep_invoice` | Bookkeep an invoice (mutation) |
| `noxctl invoices credit <docNumber>` | `fortnox_credit_invoice` | Credit an invoice (mutation) |

### Invoice payments (inbetalningar)

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl invoice-payments list [--invoice <number>]` / alias `noxctl ip list` | `fortnox_list_invoice_payments` | List invoice payments |
| `noxctl invoice-payments get <number>` | `fortnox_get_invoice_payment` | Get a single invoice payment |
| `noxctl invoice-payments create --invoice <n> --amount <a> --date <date>` | `fortnox_create_invoice_payment` | Register a payment against an invoice (mutation) |
| `noxctl invoice-payments bookkeep <number>` | — | Bookkeep an invoice payment (mutation) |
| `noxctl invoice-payments delete <number>` | `fortnox_delete_invoice_payment` | Delete an invoice payment (mutation) |

### Supplier invoices (leverantörsfakturor)

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl supplier-invoices list [--filter <status>] [--supplier <number>]` / alias `si list` | `fortnox_list_supplier_invoices` | List/filter supplier invoices |
| `noxctl supplier-invoices get <givenNumber>` | `fortnox_get_supplier_invoice` | Get a single supplier invoice |
| `noxctl supplier-invoices create --supplier <n> --input <file>` | `fortnox_create_supplier_invoice` | Create a supplier invoice (mutation) |
| `noxctl supplier-invoices bookkeep <givenNumber>` | `fortnox_bookkeep_supplier_invoice` | Bookkeep a supplier invoice (mutation) |

### Supplier invoice payments (utbetalningar)

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl supplier-invoice-payments list [--invoice <number>]` / alias `sip list` | `fortnox_list_supplier_invoice_payments` | List supplier invoice payments |
| `noxctl supplier-invoice-payments get <number>` | `fortnox_get_supplier_invoice_payment` | Get a single supplier invoice payment |
| `noxctl supplier-invoice-payments create --invoice <n> --amount <a> --date <date>` | `fortnox_create_supplier_invoice_payment` | Register a payment against a supplier invoice (mutation) |
| `noxctl supplier-invoice-payments delete <number>` | `fortnox_delete_supplier_invoice_payment` | Delete a supplier invoice payment (mutation) |

### Offers (offerter)

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl offers list [--filter <status>] [--customer <number>]` | `fortnox_list_offers` | List/filter offers. Filters: `cancelled`, `expired`, `ordercreated`, `invoicecreated` |
| `noxctl offers get <docNumber>` | `fortnox_get_offer` | Get a single offer |
| `noxctl offers create --customer <number> --input <file>` | `fortnox_create_offer` | Create an offer (mutation) |
| `noxctl offers update <docNumber> --input <file>` | `fortnox_update_offer` | Update an offer (mutation) |
| `noxctl offers create-invoice <docNumber>` | `fortnox_create_invoice_from_offer` | Convert offer → invoice (mutation) |
| `noxctl offers create-order <docNumber>` | `fortnox_create_order_from_offer` | Convert offer → order (mutation) |

### Orders (ordrar)

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl orders list [--filter <status>] [--customer <number>]` | `fortnox_list_orders` | List/filter orders. Filters: `cancelled`, `invoicecreated`, `invoicenotcreated` |
| `noxctl orders get <docNumber>` | `fortnox_get_order` | Get a single order |
| `noxctl orders create --customer <number> --input <file>` | `fortnox_create_order` | Create an order (mutation) |
| `noxctl orders update <docNumber> --input <file>` | `fortnox_update_order` | Update an order (mutation) |
| `noxctl orders create-invoice <docNumber>` | `fortnox_create_invoice_from_order` | Convert order → invoice (mutation) |

### Bookkeeping

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl vouchers list [--series <s>] [--from <date>] [--to <date>]` | `fortnox_list_vouchers` | List vouchers, optionally filtered by series and date range |
| `noxctl vouchers get <series> <number>` | `fortnox_get_voucher` | Get a single voucher with rows |
| `noxctl vouchers create --input <file>` | `fortnox_create_voucher` | Create a voucher with debit/credit rows (mutation) |
| `noxctl vouchers attach <series> <number> <file...> [--year]` | `fortnox_attach_voucher_files` | Upload receipt/underlag files and link them to a voucher (mutation; needs the Fortnox archive scope) |
| `noxctl accounts list [--search <term>]` | `fortnox_list_accounts` | View chart of accounts, search by name or number |

### Financial reports

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl reports income [--year <n>] [--from <date>] [--to <date>]` / alias `reports resultat` | `fortnox_income_statement` | Income statement (resultaträkning) |
| `noxctl reports balance [--year <n>] [--to <date>]` / alias `reports balans` | `fortnox_balance_sheet` | Balance sheet (balansräkning) |

### Tax

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl tax report --from <date> --to <date>` | `fortnox_tax_report` | Informational VAT summary for a period. Reconcile against Fortnox before filing. Dates in `YYYY-MM-DD` format |

### Tax reductions (ROT/RUT)

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl tax-reductions list [--filter <type>]` | `fortnox_list_taxreductions` | List tax reductions (ROT/RUT) |
| `noxctl tax-reductions get <id>` | `fortnox_get_taxreduction` | Get a single tax reduction |
| `noxctl tax-reductions create --reference <n> --type <rot\|rut> --document-type <type> --customer-name <name> --amount <öre>` | `fortnox_create_taxreduction` | Create a ROT/RUT tax reduction (mutation) |

### Projects

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl projects list` | `fortnox_list_projects` | List projects |
| `noxctl projects get <number>` | `fortnox_get_project` | Get a single project |
| `noxctl projects create --description <text>` | `fortnox_create_project` | Create a project (mutation) |
| `noxctl projects update <number> --input <file>` | `fortnox_update_project` | Update a project (mutation) |

### Cost centers (kostnadsställen)

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl costcenters list` | `fortnox_list_costcenters` | List cost centers |
| `noxctl costcenters get <code>` | `fortnox_get_costcenter` | Get a single cost center |
| `noxctl costcenters create --code <code> --description <text>` | `fortnox_create_costcenter` | Create a cost center (mutation) |
| `noxctl costcenters update <code> --input <file>` | `fortnox_update_costcenter` | Update a cost center (mutation) |
| `noxctl costcenters delete <code>` | `fortnox_delete_costcenter` | Delete a cost center (mutation) |

### Price lists and prices

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl pricelists list` | `fortnox_list_pricelists` | List price lists |
| `noxctl pricelists get <code>` | `fortnox_get_pricelist` | Get a single price list |
| `noxctl pricelists create --code <code> --description <text>` | `fortnox_create_pricelist` | Create a price list (mutation) |
| `noxctl pricelists update <code> --input <file>` | `fortnox_update_pricelist` | Update a price list (mutation) |
| `noxctl prices list --pricelist <code> [--article <number>]` | `fortnox_list_prices` | List prices within a price list |
| `noxctl prices get --pricelist <code> --article <number>` | `fortnox_get_price` | Get a specific price |
| `noxctl prices update --pricelist <code> --article <number> --input <file>` | `fortnox_update_price` | Update a price (mutation) |

### Contracts (avtal — recurring invoicing)

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl contracts list [--filter active\|inactive\|finished]` | `fortnox_list_contracts` | List/filter contracts |
| `noxctl contracts get <number>` | `fortnox_get_contract` | Get a single contract |
| `noxctl contracts create --customer <number> --input <file>` | `fortnox_create_contract` | Create a contract (mutation) |
| `noxctl contracts update <number> --input <file>` | `fortnox_update_contract` | Update a contract (mutation) |
| `noxctl contracts finish <number>` | `fortnox_finish_contract` | Finish a contract (mutation) |
| `noxctl contracts create-invoice <number>` | `fortnox_create_invoice_from_contract` | Create the next invoice now (mutation) |
| `noxctl contracts increase-invoice-count <number>` | `fortnox_increase_contract_invoice_count` | Extend by one invoice (mutation) |

### Financial years and locked period

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl financial-years list [--date <date>]` | `fortnox_list_financialyears` | List financial years (räkenskapsår) |
| `noxctl financial-years get <id>` | `fortnox_get_financialyear` | Get a single financial year |
| `noxctl financial-years locked-period` | `fortnox_get_lockedperiod` | Show through which date bookkeeping is locked |

### Payroll (Lön)

> **Requires the `salary` scope**, which is **opt-in**. Enable the **Lön** permission on your Fortnox app, then run `noxctl init --with-salary` (or set `FORTNOX_WITH_SALARY=1` in non-interactive setups). Without it, these endpoints return `403 Forbidden`. See [Setup](#1-create-a-fortnox-app).

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl employees list` | `fortnox_list_employees` | List employees |
| `noxctl employees get <employeeId>` | `fortnox_get_employee` | Get a single employee |
| `noxctl employees create --first-name <n> --last-name <n> --email <e> [--employment-form <f> --personel-type <t> --salary-form <f>]` | `fortnox_create_employee` | Create an employee (mutation). `--employment-form`/`--personel-type`/`--salary-form` are required *unless* the company has a default employment agreement — otherwise Fortnox rejects with a `ftgavtalid` error |
| `noxctl employees update <employeeId> --input <file>` | `fortnox_update_employee` | Update an employee (mutation) |
| `noxctl salary-transactions list [--employee <id>] [--date <date>]` | `fortnox_list_salarytransactions` | List salary transactions |
| `noxctl salary-transactions get <salaryRow>` | `fortnox_get_salarytransaction` | Get a single salary transaction |
| `noxctl salary-transactions create --employee <id> --salary-code <code> --date <date> [--amount <n>]` | `fortnox_create_salarytransaction` | Create a salary transaction (mutation) |
| `noxctl salary-transactions delete <salaryRow>` | `fortnox_delete_salarytransaction` | Delete a salary transaction (mutation) |
| `noxctl attendance-transactions list [--employee <id>] [--date <date>]` | `fortnox_list_attendancetransactions` | List attendance (närvaro) transactions |
| `noxctl attendance-transactions get <id>` | `fortnox_get_attendancetransaction` | Get a single attendance transaction |
| `noxctl attendance-transactions create --employee <id> --cause-code <code> --date <date> [--hours <n>]` | `fortnox_create_attendancetransaction` | Create an attendance transaction (mutation) |
| `noxctl attendance-transactions delete <id>` | `fortnox_delete_attendancetransaction` | Delete an attendance transaction (mutation) |
| `noxctl absence-transactions list [--employee <id>] [--date <date>]` | `fortnox_list_absencetransactions` | List absence (frånvaro) transactions |
| `noxctl absence-transactions get <id>` | `fortnox_get_absencetransaction` | Get a single absence transaction |
| `noxctl absence-transactions create --employee <id> --cause-code <code> --date <date> [--hours <n>] [--extent <n>]` | `fortnox_create_absencetransaction` | Create an absence transaction (mutation) |
| `noxctl absence-transactions delete <id>` | `fortnox_delete_absencetransaction` | Delete an absence transaction (mutation) |
| `noxctl schedule-times get <employeeId> <date>` | `fortnox_get_scheduletime` | Get the schedule for an employee on a date |
| `noxctl schedule-times update <employeeId> <date> --input <file>` | `fortnox_update_scheduletime` | Update a day's schedule (mutation) |
| `noxctl schedule-times reset-day <employeeId> <date> --input <file>` | `fortnox_reset_scheduletime_day` | Update a day's schedule and reset the day (mutation) |

### Analytics and dashboard

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl analytics overdue` | `fortnox_overdue_invoices` | Overdue invoices summary |
| `noxctl analytics unpaid` | `fortnox_unpaid_totals` | Outstanding receivables, with overdue split |
| `noxctl analytics top-customers [--period <period>]` | `fortnox_top_customers` | Top customers by invoiced amount |
| `noxctl analytics vat --period <period>` | `fortnox_vat_summary` | VAT summary with net VAT position |
| `noxctl dashboard` | — | At-a-glance: outstanding, overdue, recent invoices, monthly revenue |

### Company

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl company info` | `fortnox_company_info` | Company name, org number, address, and settings |

### Utility

| CLI | MCP tool | Description |
|-----|----------|-------------|
| `noxctl init` | — | Interactive setup wizard — connects to Fortnox, stores credentials, optionally registers MCP server |
| `noxctl doctor` | `fortnox_status` | Validate setup: Node version, credentials, token status, API connectivity, and scopes |
| `noxctl logout` | — | Remove stored credentials from the OS keychain |
| `noxctl profile use <name>` | — | Set the active profile (writes `~/.fortnox-mcp/active-profile`) |
| `noxctl profile current` | — | Show the currently resolved profile and where it came from |
| `noxctl profile list` | — | List known profiles from the index |
| `noxctl completion <bash\|zsh\|fish>` | — | Generate a shell completion script |

## CLI output

By default, `noxctl` uses **table output** on interactive terminals and **JSON** when piped or redirected. Override with `-o`:

```bash
noxctl invoices list              # table on terminal, JSON when piped
noxctl -o json invoices list      # force JSON (JavaScript Object Notation)
noxctl -o table invoices list     # force table
noxctl invoices list | jq .       # auto-JSON (piped)
```

JSON output has a stable envelope: list commands wrap under the plural resource key (`{"Invoices": [...], "MetaInformation": {...}}`) and single-resource commands under the singular key (`{"Invoice": {...}}`), so scripted callers can rely on a fixed accessor. Failures in JSON mode are emitted to stderr as a structured envelope:

```json
{ "error": { "status": 400, "message": "...", "source": "fortnox-api" } }
```

Natural date periods are accepted wherever `--from`/`--to` work, via `--period`: `Q1`, `2025-Q3`, `march`/`mars`, `this-quarter`, `last-quarter`, `this-month`, `last-month`, `ytd`, `this-year`, `last-year`, or a bare year. Periods are **calendar-year** based (broken fiscal years are not yet considered).

When running from a local clone instead of an installed binary, replace `noxctl` with `node dist/cli.js`.

## Mutation safety

Mutating commands require confirmation before executing. On interactive terminals, the CLI prompts with `[y/N]`. In non-interactive contexts (piped input, CI), pass `--yes` explicitly or the command will fail safely.

CLI:

```bash
noxctl invoices send 1001                              # prompts: "Send invoice 1001 via email. Continue? [y/N]"
noxctl invoices send 1001 --yes                        # skip prompt (scripting/AI)
noxctl invoices send 1001 --dry-run                    # preview without sending
noxctl customers update 42 --input customer.json       # prompts for confirmation
noxctl vouchers create --input voucher.json --dry-run  # preview payload
```

MCP tools:

- Mutating tools require `confirm: true`
- Use `dryRun: true` to preview a request without sending it
- Raw Fortnox JSON is opt-in via `includeRaw: true`
- `includeRaw: true` can expose more accounting and personal data to AI transcripts, logs, and terminals than the summarized default output

## Privacy and AI Use

If you use noxctl through Claude, MCP clients, or other AI tooling, customer, supplier, invoice, and bookkeeping data may leave the local Fortnox UI context and enter third-party systems.

- Keep `includeRaw` off unless you truly need the full payload
- Review your AI provider's retention, logging, and processor terms
- Make sure your GDPR setup covers this use, including processor agreements and any required third-country transfer assessment
- Prefer synthetic data when testing prompts, demos, and examples

See [PRIVACY.md](PRIVACY.md) for the project-specific privacy notes.

## Tax and Accounting Limits

noxctl can help you inspect Fortnox data and submit operations you choose to confirm. It does not make legal judgments for you.

- The VAT report is an informational summary, not a filed declaration
- Swedish bookkeeping responsibility remains with the company owner or board
- Review invoices, vouchers, and VAT totals before confirming or filing anything
- Reconcile VAT figures against Fortnox's own momsrapport and your accounting records before submitting to Skatteverket

## Examples

Ask Claude naturally — works in both Swedish and English:

- "Skapa en faktura till kund 42 för 10 konsulttimmar á 1200 kr"
- "Create an invoice for customer 42: 10 consulting hours at 1200 SEK (Swedish Krona)"
- "Visa alla obetalda fakturor" / "Show all unpaid invoices"
- "Vad har vi för utgående moms Q1 2025?" / "What's our outgoing VAT for Q1 2025?"
- "Bokför kontorsmaterial för 1250 kr inkl moms" / "Book office supplies for 1250 SEK incl VAT"
- "Skicka faktura 1001 via e-post" / "Send invoice 1001 by email"

## Troubleshooting

**"stdin is not a TTY. Set FORTNOX_CLIENT_ID and FORTNOX_CLIENT_SECRET env vars to run non-interactively"**

`noxctl init` is normally interactive — it prompts for the Client ID and Secret. In CI or other non-TTY contexts it falls back to reading them from environment variables:

```bash
export FORTNOX_CLIENT_ID=<your-id>
export FORTNOX_CLIENT_SECRET=<your-secret>
export FORTNOX_SERVICE_ACCOUNT=1   # optional, enables service account mode
noxctl init
```

Once authorized, the tokens are stored in the OS keychain. No env vars are needed afterwards — only for re-running `init` non-interactively.

**"Not authenticated. Run `noxctl init`"**

Credentials are missing or were not saved. Re-run the setup step. On macOS, check that Keychain Access is not blocking the `security` command. On Linux, ensure `secret-tool` is installed (`sudo apt install libsecret-tools`).

**403 Forbidden from Fortnox API**

Your app is missing one or more scopes. The error message names the specific scope needed (e.g. `Missing "supplier" scope`). Go to [developer.fortnox.se](https://developer.fortnox.se/), open your app, and enable the matching permission under **Behörigheter** / **Permissions** — see the full table in [Setup → Create a Fortnox app](#1-create-a-fortnox-app). Then re-run `noxctl init`.

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
npm run lint         # ESLint with typescript-eslint
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

## Glossary

| Abbreviation | Full term |
|---|---|
| AI | Artificial Intelligence |
| API | Application Programming Interface |
| BCC | Blind Carbon Copy — an email field that sends a copy to someone without other recipients seeing it |
| CLI | Command Line Interface — a text-based way to interact with software by typing commands |
| DPAPI | Data Protection API — a Windows feature for encrypting stored credentials |
| JSON | JavaScript Object Notation — a widely used format for structured data |
| MCP | Model Context Protocol — a standard that lets AI assistants use external tools and data sources |
| MIT | Massachusetts Institute of Technology — refers to a permissive open-source software license |
| npm | Node Package Manager — a tool for installing and managing JavaScript packages |
| npx | A tool included with npm for running packages without installing them globally |
| OAuth | Open Authorization — a standard protocol for granting apps limited access to accounts without sharing passwords |
| OS | Operating System — the software that runs your computer (e.g. macOS, Windows, Linux) |
| SEK | Swedish Krona — the currency of Sweden |
| URI | Uniform Resource Identifier — an address that identifies a resource (similar to a web link) |
| VAT | Value Added Tax — a consumption tax added at each stage of production |

## Disclaimer

noxctl is an independent, **unofficial** open-source project — **not affiliated with, endorsed by, or certified by Fortnox AB.** "Fortnox" is a trademark of Fortnox AB, used here only to describe interoperability.

**No warranty, no liability.** noxctl is provided "as is", without warranty of any kind, express or implied. The author and contributors accept **no responsibility and no liability whatsoever** for anything arising from its use — including, without limitation: incorrect, incomplete, or lost bookkeeping; erroneous invoices, payments, payroll, or tax filings; exposure or loss of data; service downtime; financial loss; or any breach of Fortnox's terms. **You use it entirely at your own risk.** (See the MIT License below — the same limitation applies in full.)

**You are responsible for everything you do with it.** Under Swedish law (Bokföringslagen), the company owner or board bears full responsibility for the correctness of all accounting and payroll records, regardless of the tools used. noxctl only executes the instructions you give it — review entries before confirming, especially with `--yes` / `confirm: true`, and reconcile against Fortnox and your own records.

**Privacy / personal data.** noxctl can move accounting *and personal* data out of Fortnox — customer/supplier details and, via the payroll commands, employee personal data such as Swedish personal identity numbers (personnummer), salaries, and absence records. When using it with AI assistants or MCP hosts, that data may enter third-party systems. Keep `includeRaw: false` unless full payloads are necessary, and ensure your use complies with GDPR, processor/data-processing agreements, and any required transfer assessments. See `PRIVACY.md`.

**Tax note:** The VAT report is an informational summary only. Reconcile it against Fortnox and your accounting records before submitting anything to Skatteverket.

**Fortnox API access** requires your own Fortnox account, developer app, and credentials. You must comply with the applicable Fortnox developer terms. noxctl ships no shared credentials, redistributes no Fortnox-owned code or data (not even Fortnox's OpenAPI spec — only opaque drift-detection hashes), and routes nothing through any server operated by the author — it calls the Fortnox API directly from your machine.

### Your responsibilities under Fortnox's terms

When you register a Fortnox developer app to use noxctl, **you** (not the noxctl author) accept Fortnox's [Developer Agreement](https://www.fortnox.se/developer) and are the contracting party. In particular:

- **Eligibility:** registering a Fortnox developer app requires a company registered under Swedish law (Developer Agreement cl. 5.1).
- **Running it for someone else's Fortnox** (e.g. as a bookkeeper/accountant for a client) makes you a data processor — you must have a data-processing agreement (*personuppgiftsbiträdesavtal*) with that client (cl. 12.3). Using it for your own company does not trigger this.
- **Sending data to AI/LLMs:** Fortnox does not prohibit it, but you are responsible for the lawfulness of distributing personal data (cl. 13.5 + GDPR) — especially payroll (Lön) and ROT/RUT data, which contain personal identity numbers (personnummer). Ensure a lawful basis and, where required, a data-processing agreement with your AI provider and a valid transfer mechanism for non-EU/EES providers.
- noxctl is a **client for Fortnox's own API** — a complement, not a replacement — using only documented endpoints and your own credentials.

## License

MIT
