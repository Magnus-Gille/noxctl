# TODO

## Current State

- Published to npm as `noxctl@0.1.0`
- 14 operations modules: invoices, customers, suppliers, articles, vouchers, accounts, financial reports, tax, company, invoice payments, supplier invoice payments, offers, orders
- Full sales pipeline: offer → order → invoice → payment
- 254 unit tests across 31 files

## Backlog

### Tier 2 — Usability

1. Better confirmation preview (show payload before y/N prompt)
2. Selective analytics MCP tools (overdue invoices, unpaid totals, top customers, VAT summary)
3. Shell completions
4. Natural date periods (`Q1`, `march`) — needs fiscal-year design first
5. Claude Desktop auto-registration in `init`

### Tier 3 — More API Coverage

6. **Projects / Cost Centers** — tracking revenue/costs per project
7. **Contracts** — recurring invoicing automation
8. **Tax Reductions (ROT/RUT)** — essential for Swedish tradespeople
9. **Price Lists / Prices** — multi-tier pricing
10. **Financial Years / Locked Period** — context for period-aware operations

### Tier 4 — Backlog

11. CLI `dashboard` command
12. Bilingual MCP descriptions (Swedish primary + English keywords)
13. MCP capability resource
14. Bank transactions (requires enabling Bank API scope)
15. File attachments (underlag) — upload receipts, attach to vouchers
16. Live mutation test coverage — only read paths tested live

## Adding a New Resource

Each Fortnox resource follows the same pattern — 5 files:

1. `src/operations/<resource>.ts` — API calls (list, get, create, update, etc.)
2. `src/tools/<resource>.ts` — MCP tool registrations with Zod schemas (Swedish descriptions)
3. `src/views.ts` — add column definitions for list/detail/confirm views
4. `src/cli.ts` — Commander subcommands mirroring the MCP tools 1:1
5. `src/index.ts` — register the tools

Tests (3 files):
- `tests/operations/<resource>.test.ts` — unit tests for operations (mock fetch)
- `tests/tools/<resource>.test.ts` — MCP integration tests (in-memory transport)
- `tests/cli.test.ts` — add smoke tests for `--help` output

Also update `src/fortnox-client.ts` endpoint-to-scope mapping if the resource uses a new scope.
