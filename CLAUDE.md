# CLAUDE.md — noxctl

## What is this?

CLI and MCP server for Fortnox accounting (invoices, customers, bookkeeping, VAT).

## CLI-first in Claude Code

**Prefer the CLI over MCP tools when running in Claude Code.** The MCP server exists for environments without a shell (Claude Desktop, Web, Mobile).

```bash
# Reading data
noxctl invoices list
noxctl invoices list --output json
noxctl customers get 25

# Writing data (prompts for confirmation on TTY; use --yes to skip)
echo '{"InvoiceRows": [...]}' | noxctl invoices update 28 --input - --yes
noxctl invoices send 28              # prompts: Continue? [y/N]
noxctl invoices send 28 --yes        # skip prompt (non-interactive/scripting)

# Dry run first
noxctl invoices create --customer 25 --input data.json --dry-run
```

## Project structure

- `src/operations/` — Fortnox API calls (shared by CLI and MCP)
- `src/tools/` — MCP tool registrations (Zod schemas)
- `src/cli.ts` — Commander CLI definitions
- `src/fortnox-client.ts` — HTTP client with rate limiting and retry
- `src/views.ts` — Column definitions for table output
- `src/formatter.ts` — Table/JSON output formatting

## Dev commands

```bash
npm run build       # TypeScript compile
npm test            # Vitest (193 unit tests)
npm run test:live   # Live API tests (needs credentials)
npm run lint        # ESLint
npm run format      # Prettier
```

## Conventions

- All MCP tool descriptions are in Swedish
- CLI commands mirror MCP tools 1:1
- Mutations prompt for confirmation on TTY; require `--yes` when piped (CLI) or `confirm: true` (MCP)
- Both support `--dry-run` / `dryRun` to preview without executing
