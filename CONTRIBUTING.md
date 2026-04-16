# Contributing to noxctl

Thanks for your interest in noxctl. This guide covers how to set up a dev environment,
the project conventions, and the pull-request process.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Open an issue first for anything non-trivial (new resource, new CLI flag, behaviour change).
  A short discussion tends to save a lot of rework.
- For small things — typos, doc fixes, obvious bug fixes — a PR directly is fine.
- Do not include real customer, supplier, invoice, or company data in issues, PRs,
  tests, examples, or commits. Use synthetic placeholders (`Acme AB`, `556677-8899`, etc.).
- Security issues: follow [SECURITY.md](SECURITY.md) — do not open a public issue.

## Dev setup

Prerequisites: Node.js 20+ and (on Linux) `secret-tool` for the keychain-backed tests.

```bash
git clone https://github.com/Magnus-Gille/fortnox-mcp.git
cd fortnox-mcp
npm install
npm run build
```

Common scripts:

```bash
npm test              # Vitest — 323 unit tests
npm run test:watch    # Vitest in watch mode
npm run test:live     # Live Fortnox tests (requires credentials — opt-in)
npm run lint          # ESLint (typescript-eslint)
npm run format        # Prettier (writes)
npm run format:check  # Prettier (check only, what CI runs)
npm run build         # tsc
```

CI runs `build`, `test`, and `format:check` on Node 20 and 22 — all three must pass.

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full module map. The short version:

- `src/operations/` — pure Fortnox API calls (shared by CLI and MCP)
- `src/tools/` — MCP tool registrations (Zod schemas, Swedish descriptions)
- `src/cli.ts` — Commander CLI subcommands mirroring MCP tools 1:1
- `src/views.ts` — column definitions for table output
- `src/formatter.ts` — table/JSON output rendering
- `src/fortnox-client.ts` — HTTP client (rate limit, retry, scope hints)
- `tests/operations/`, `tests/tools/`, `tests/cli.test.ts` — unit/integration tests

## Conventions

- **CLI ↔ MCP parity.** Every MCP tool has a matching CLI command and vice versa.
  If you add one, add the other.
- **MCP tool descriptions are in Swedish.** Help text, parameter descriptions, and
  error messages presented via MCP should be in Swedish. CLI `--help` is in English.
- **Mutations require confirmation.** New write operations must honour the existing
  pattern: interactive TTY prompt, `--yes` to skip, `--dry-run` to preview (CLI);
  `confirm: true` and `dryRun: true` (MCP).
- **Summarized output by default.** MCP tools return compact summaries. Raw Fortnox
  JSON is opt-in via `includeRaw: true` — treat the raw path as higher-risk.
- **Retries are for idempotent requests only.** Do not retry `POST`/`PUT`/`DELETE`.
- **No secrets in errors.** Client secrets, tokens, and OAuth codes must never be
  emitted in tool responses, logs, or error messages.

## Adding a new resource

Follow the recipe in [TODO.md → Adding a New Resource](TODO.md#adding-a-new-resource).
Concretely, a new resource `<name>` usually means:

1. `src/operations/<name>.ts` — list/get/create/update/delete as needed
2. `src/tools/<name>.ts` — MCP registrations with Zod schemas (Swedish descriptions)
3. `src/views.ts` — column definitions for list/detail/confirm views
4. `src/cli.ts` — Commander subcommand group mirroring the MCP tools
5. `src/index.ts` — register the tools
6. If a new scope is introduced, add it to the `endpointToScope` mapping in
   `src/fortnox-client.ts` **and** to the scope table in `README.md`

Tests:

- `tests/operations/<name>.test.ts` — unit tests (mocked `fetch`)
- `tests/tools/<name>.test.ts` — MCP tool integration tests (`InMemoryTransport`)
- `tests/cli.test.ts` — smoke test for `--help` output

## Commits and pull requests

- One logical change per PR. Don't bundle refactors with behaviour changes.
- **Conventional commits** are expected (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).
  Scan `git log` for examples.
- Run `npm run format` and `npm run lint` before pushing. Husky runs Prettier on
  staged files automatically, but running the full check locally catches CI failures early.
- Update `README.md` if you add, remove, or rename a public CLI/MCP command.
- Update `TODO.md` when finishing a backlog item (strikethrough + ✅).
- Include new/updated tests. CI is the bar; aim for the behaviour your PR changes
  to be covered.
- Keep PR descriptions concrete: what changed, why, and anything a reviewer should
  double-check (new scope, new external call, privacy impact, etc.).

## API drift

When the Fortnox OpenAPI spec changes, the weekly `api-drift` workflow opens a
GitHub issue labelled `api-drift` with the diff. If you pick up such an issue:

1. Read the diff summary on the issue.
2. Decide which changes require action (new fields to expose, breaking changes).
3. Update operations/tools/tests and refresh `api-spec/openapi.json` in the same PR.

## Questions

Open a GitHub discussion or issue. For anything you'd rather not discuss in public
(e.g. security, licensing concerns, Fortnox terms), email `magnus.gille@outlook.com`.
