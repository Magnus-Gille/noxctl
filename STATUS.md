# Project Status

**Updated:** 2026-07-13
**Branch:** `hardening/reliability-2026-07-13`
**Base:** `origin/main` at `933631964b12bc07ee70bc1e7e89f77476c17df4`
**State:** `0.4.1` release candidate is open as draft PR #65; parent Codex approved the initial hardening commit because Claude Opus was unavailable. Awaiting CI and final merge/release approval. Nothing has been published.

## Hardening completed

- OAuth refreshes are single-flighted per case-insensitive profile, preventing concurrent refresh-token rotation and duplicate credential writes. OAuth calls have a 30-second deadline.
- Fortnox calls have explicit deadlines (30 seconds; 120 seconds for raw-body uploads). Only reads retry transient network failures and HTTP 429/5xx responses, with three retries and a 30-second delay cap. Mutations remain single-attempt; mutation timeouts explicitly report that the remote outcome may be unknown.
- Rate-limit admission is serialized so concurrent callers cannot exceed the existing 25-requests-per-5-seconds budget.
- Default employee detail summaries redact personnummer and exact monthly/hourly pay. Exact fields require explicit CLI JSON or MCP `includeRaw`; MCP descriptions warn about sensitive payroll data. Mutation payload previews remain exact by design.
- CI/publishing now require lint, formatting, build, tests, production audit, and package dry-run. The lockfile received audit-compatible transitive-only updates; direct dependency ranges did not change.

## Verification

- `npm run check:release` — passed on Node `v22.17.0`: lint, Prettier check, TypeScript build, **66 test files / 722 tests**, production audit, and package dry-run.
- `npm audit` — **0 vulnerabilities** across production and development dependencies (277 dependencies total).
- `npm ls --depth=0` — clean dependency tree.
- No live Fortnox calls or real accounting/payroll mutations were performed.

## Review and rollout

1. Review the release-version commit and require PR #65's Node 20/22 CI to pass.
2. Merge only after approval and green CI.
3. Tag/release `v0.4.1` and publish `noxctl@0.4.1` to npm using the normal release process. This npm patch is the deployment; the repository has no daemon or host rollout, and no Heimdall change is appropriate.

Rollback after a future npm publish: revert the merge commit; restore `latest` to `noxctl@0.4.0` with `npm dist-tag add noxctl@0.4.0 latest`; deprecate the superseded patch if needed. Existing installations remain on their installed version unless explicitly upgraded.

## Residual risks

- Node 20 was not available locally; the PR's existing Node 20/22 matrix is the remaining compatibility gate.
- Fixed 30/120-second deadlines may need tuning from field evidence, but retries and delays are now bounded.
- Explicit CLI JSON, MCP `includeRaw`, mutation confirmations, and dry-run payloads can still contain payroll PII by design; callers must treat them as sensitive.
- Tests mock Fortnox transport. No mutation was live-tested in this hardening pass because preserving production data was a hard constraint.
