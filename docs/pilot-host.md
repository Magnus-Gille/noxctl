# Pilot host (NOX-214)

An unpublished, operator-run host that connects the shadow queue and Accounted adapters to a
real Fortnox company and ONE Accounted pilot company. It lives in `src/pilot/`, is built to
`dist/pilot/`, is NOT exported from `noxctl/embedded`, is NOT a `bin`, and is excluded from the npm
tarball (`"!dist/pilot/"` in `package.json` `files`). Fortnox stays authoritative. Nothing is
automatic: every Accounted write is one explicit operator command.

## Configuration

A JSON file (owned regular file, not a symlink, at most 8 KB, not group/world writable) with
exactly these keys; it holds identities and paths, never credentials:

```json
{
  "version": 1,
  "profile": "noxctl-profile-name",
  "directory": "/absolute/private/pilot-dir",
  "sourceCompany": "Fortnox OrganizationNumber, compared exactly",
  "targetCompany": "lowercase Accounted company UUID",
  "accountedOrigin": "https://host[:port]",
  "keychainService": "...",
  "keychainAccount": "...",
  "revision": "64-hex SHA256 of the reviewed host artifact"
}
```

The Fortnox transport is the existing profile auth (`profile` is bound with the same mechanism as
`noxctl --profile`). The Accounted API key is read per request from the macOS keychain with
`security find-generic-password -s <service> -a <account> -w` (no shell) and is never logged or
written to errors or receipts.

## Commands

`node dist/pilot/cli.js --config <file> [--synthetic-source] <command>`

| Command                               | Effect                                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                              | Counts, oldest unapplied age, every non-applied record with state and reason, and source number to target id for applied records. Also acknowledges the queue state. |
| `preview <id>`                        | Only for the OLDEST unresolved record. Runs the adapter `prepare` (no network), prints the exact request and `hash`, writes `previews/<id>.json` (0600).             |
| `drain-one <id> <hash>`               | One `queue.drainOne`, after the checks below. Prints the resulting state, then backs up.                                                                             |
| `baseline-customer <CustomerNumber>`  | Reads the Fortnox customer and records a `baselineCustomer` intent (pending). No Accounted request.                                                                  |
| `link-article <ArticleNumber> <uuid>` | Reads the Fortnox article and records a `baselineArticle` intent (pending). No Accounted request.                                                                    |
| `backup`                              | Manual backup.                                                                                                                                                       |

`hash = sha256(canonicalEncode({ id, operation, requestHash, request, binding, revision }))`.

`drain-one` requires: the write gate ok (except this record's own pending state); a preview file
for this id whose hash equals the argument, younger than 15 minutes, made by the same OS user;
the recomputed hash still equal (no drift); the id still the oldest unresolved record; operation in
`createCustomer`, `baselineCustomer`, `baselineArticle`, `createInvoice`. For `createInvoice` the
Fortnox invoice is read first and compared with the stored source result (every populated key
except `@`-keys); a change, or Booked/Sent/Cancelled, refuses. After an applied invoice it is read
again and any change is reported (never undone). The preview file is consumed.

`node dist/pilot/server.js --config <file> [--synthetic-source]` runs the five staged MCP tools.
`--synthetic-source` swaps Fortnox for a deterministic in-memory transport (rehearsal).

## Safety rules

- Accounted requests are restricted by an allowlist to: `GET /api/v1/companies`, `GET` customer or
  invoice by UUID (optionally `?expand=items`), `GET` articles with `include_inactive=true`, and
  `POST` to the customers or invoices collection of the configured company. Anything else (DELETE,
  PATCH, PUT, mark-sent, mark-paid, send, book, other companies, other query strings) throws
  `PilotPolicyError` before any network I/O; the queue records `target_unknown` (a stop), never
  `applied`.
- Before EVERY POST the client lists companies and requires exactly one entry with the configured
  id and no further page; otherwise `PilotNotDispatchedError` (a `TargetNotDispatchedError`, so
  `retry_wait`) and no POST is sent. Key retrieval failure is handled the same way.
- Redirects are never followed (any 3xx is an error). TLS verification is the Node default.
  Timeout 30 s. Any error after `fetch()` was invoked for a POST (timeout, network, non-JSON) is an
  ordinary error, so the queue records `target_unknown`; it is never retried automatically.
- Write gate (`checkWriteGate`): refuses when any record is blocked, source_unknown,
  source_in_flight, target_unknown, target_in_flight, prepared, retry_wait or deferred, when a
  staged call is executing or unknown, when the oldest unapplied record is older than 24 h, or when
  storage/backup failed. `authorize` also reads Fortnox `companyinformation` and requires the exact
  configured organization number. `get`/`list`/`status` staged actions stay available.
- Backups: after every staged execute response and every drain, `VACUUM INTO` copies of
  `staged.sqlite` and `queue/shadow.sqlite` go to `backups/<ISO>/` (0700 dirs, 0600 files) with a
  `manifest.json` of sha256 values; integrity is checked. A `backup-pending` marker is written
  before each mutation and removed only by a successful backup; while it exists (also after a
  crash) the gate refuses.
- Restore: `ack.json` holds a fingerprint of the queue as last seen by the host. After restoring
  files from a backup (or any outside change) the gate refuses until the operator runs `status`.

## Recovery

- Never delete the queue or `staged.sqlite`; they are the receipts.
- Never retry an unknown outcome. `target_unknown`, `source_unknown` and `source_in_flight` need
  read-only reconciliation against the real systems.
- Abandoning the pilot Accounted company and starting a fresh one (new binding, new directory) is
  preferred over repairing an unresolved pilot state.
