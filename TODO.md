# TODO

## Current State

- Published to npm as `noxctl@0.6.0` (2026-07-21)
- Invoice PDF export: `noxctl invoices pdf` / `fortnox_invoice_pdf`
- Requires Node.js >=22.12.0; uses Commander 15
- 27 operations modules: invoices, customers, suppliers, supplier invoices, articles, vouchers, accounts, financial reports, financial years/locked period, tax, company, invoice payments, supplier invoice payments, offers, orders, contracts, recurrings, projects, cost centers, tax reductions (ROT/RUT), price lists, analytics, employees, salary transactions, attendance transactions, absence transactions, schedule times
- Full sales pipeline: offer → order → invoice → payment
- Payroll (Lön): employees + salary/attendance/absence transactions + schedule times (opt-in `salary` scope via `init --with-salary`)
- 759 unit tests across 67 files

## API Drift Detection

Weekly GitHub Actions workflow (`api-drift.yml`) fetches the Fortnox OpenAPI spec and compares it against the committed **fingerprint** (`api-spec/openapi-fingerprint.json` — opaque hashes only; the full spec is not stored in the repo, per Fortnox Developer Agreement cl. 6.1/6.3). Opens a GitHub issue labeled `api-drift` when endpoints/schemas change. Run locally with `npm run check:api`. Can also be triggered manually from the Actions tab.

## Backlog

### Tier 2 — Usability

1. ~~Better confirmation preview (show payload before y/N prompt)~~ ✅ Done
2. ~~Selective analytics MCP tools (overdue invoices, unpaid totals, top customers, VAT summary)~~ ✅ Done
3. ~~Shell completions~~ ✅ Done
4. ~~Natural date periods (`Q1`, `march`)~~ ✅ Done (calendar-year based; fiscal-year awareness still open)
5. Claude Desktop auto-registration in `init`

### Tier 3 — More API Coverage

6. ~~**Projects / Cost Centers**~~ ✅ Done
7. ~~**Contracts** — recurring invoicing automation~~ ✅ Done
8. ~~**Tax Reductions (ROT/RUT)**~~ ✅ Done
9. ~~**Price Lists / Prices**~~ ✅ Done
10. ~~**Financial Years / Locked Period**~~ ✅ Done
17. ~~**Payroll / Lön** — employees, salary/attendance/absence transactions, schedule times (opt-in `salary` scope)~~ ✅ Done

### Tier 4 — Backlog

11. ~~CLI `dashboard` command~~ ✅ Done
12. Bilingual MCP descriptions (Swedish primary + English keywords)
13. MCP capability resource
14. Bank transactions — **blocked upstream, not a scope toggle.** A freshly fetched
    Fortnox OpenAPI spec (2026-07-21, 233 paths) contains **zero** `/3/bank*`
    endpoints; this is a separate Fortnox Bank/Finans product surface, so there is
    nothing to implement against from the standard REST API. See issue #13.
15. ~~File attachments (underlag) — upload receipts, attach to vouchers~~ ✅ Done (#37) — `noxctl vouchers attach`; live use needs the **archive** scope
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
