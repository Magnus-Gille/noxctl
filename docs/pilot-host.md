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
written to errors or receipts. For a POST the key is retrieved and validated once and the same value
is used for the company check and the POST, so both requests always carry the same identity.

## Commands

`node dist/pilot/cli.js --config <file> [--synthetic-source] <command>`

| Command                               | Effect                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                              | Counts, oldest unapplied age, every non-applied record with state and reason, and source number to target id for applied records. Also acknowledges the queue state.                                                                                     |
| `preview <id>`                        | Only for the OLDEST unresolved record. Runs the adapter `prepare` (no network), prints the exact request and `hash`, writes `previews/<id>.json` (0600).                                                                                                 |
| `drain-one <id> <hash>`               | One `queue.drainExpected` (below), after the checks below. Prints the state, then backs up.                                                                                                                                                              |
| `baseline-customer <CustomerNumber>`  | Reads the Fortnox customer and records a `baselineCustomer` intent (pending). No Accounted request.                                                                                                                                                      |
| `link-article <ArticleNumber> <uuid>` | Reads the Fortnox article and records a `baselineArticle` intent (pending). No Accounted request.                                                                                                                                                        |
| `reconcile <id>`                      | Only for a `target_unknown` record that kept its target identity and receipt. Reads the target with the adapter's verifier (GET only, never another mutation); on a match the record becomes `applied`, otherwise it stays unknown. Backs up afterwards. |
| `backup`                              | Manual backup.                                                                                                                                                                                                                                           |

`hash = sha256(canonicalEncode({ id, operation, requestHash, request, binding, revision }))`.

`drain-one` requires: the write gate ok (except this record's own pending state); a preview file
for this id whose hash equals the argument, younger than 15 minutes, made by the same OS user;
the recomputed hash still equal (no drift); the id still the oldest unresolved record; operation in
`createCustomer`, `baselineCustomer`, `baselineArticle`, `createInvoice`. For `createInvoice` the
Fortnox invoice is read first and compared with the stored source result (every populated key
except `@`-keys); a change, or Booked/Sent/Cancelled, refuses. After an applied invoice it is read
again and any change is reported (never undone). The preview file is consumed.

The dispatch itself is `queue.drainExpected(adapter, { id, expectedDigest, digestOf, beforeApply })`.
INSIDE the claim transaction it requires the oldest unresolved non-payment record to be exactly `id`
in `pending`/`retry_wait`, runs `adapter.prepare`, and requires `digestOf(record, request)` (the
preview hash, recomputed from the freshly prepared request) to equal the hash bound at preview;
otherwise nothing is claimed and a refusal reason is returned. A second drain validated against the
same preview therefore cannot dispatch the next record.

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

## Pilot lock

`<directory>/pilot.lock` is created with exclusive-create (mode 0600) and holds
`{pid, command, startedAt}`. Every mutation (`baseline-customer`, `link-article`, `drain-one`,
`backup`, and the MCP server's `staged_prepare`/`staged_execute`) holds it for its whole duration,
including the backup, and removes it in `finally`. If it exists the operation is refused with a
clear message. It is never waited on and never deleted automatically: a stale lock (crash, kill -9)
is removed by the operator, by hand, only after confirming that no pilot CLI or server is running
and then running `status` and `backup`.

Storage health is the `backup-pending` marker, re-read from disk at every gate check (not cached
in a process), so a mutation begun by another process is seen immediately. A backup removes the
marker only while holding the lock, so it covers every completed mutation.

## Dispatch journal, restore and reconciliation

`<directory>/journal/dispatch.jsonl` (directory 0700, file 0600, fsync after every append) is
append-only and lives OUTSIDE the backed-up databases: backups never copy it and a restore never
touches it. Entries are written immediately before the external write:

- `{"kind":"target","intentId","requestHash","attempt","at"}` after the drain claim and before any
  Accounted request. If the append fails the request is not sent and the record goes to
  `retry_wait` (not dispatched).
- `{"kind":"source","stagedId","at"}` immediately before every Fortnox write run by the staged
  server. If the append fails the write is not made.

### Genesis, hash chain and head record

- When a pilot directory is first initialized (no `pilot-id`, no journal, and both databases absent
  or empty) the host writes, in this order: the head record, the journal's first line
  `{"kind":"genesis","pilotId":<uuid>,"createdAt"}`, and `<directory>/pilot-id` (0600).
- Every later line carries `seq` (1, 2, 3, ...) and `prev`, the sha256 of the previous raw line.
- The independent head record `~/Library/Application Support/noxctl-pilot/<pilotId>.head.json`
  (directory 0700, file 0600) holds `{pilotId, seq, hash}` of the last journal line. It is
  rewritten (temp file, fsync, rename, fsync of the directory) after every append. It is not under
  the state directory, so restoring or deleting the state directory does not touch it. (The
  location is injectable in the host dependencies for tests.)
- A crash between the journal append and the head update leaves the journal one line ahead of the
  head; the gate refuses this like any mismatch (fail closed) and needs reconciliation.

The write gate fails closed (every mutation, CLI or MCP) when:

- `pilot-id` exists but the journal is missing, empty, lacks a valid genesis with that pilot id, has
  a broken seq/prev chain, or its last line differs from the head record (seq and hash);
- the head record is missing for an initialized pilot;
- the databases are not empty (or a journal exists) but `pilot-id` is missing;
- `pilot-id` exists but `staged.sqlite` or `queue/shadow.sqlite` was missing at startup (checked
  before the opener could create an empty one);
- a journaled target intent is absent from the queue, has a different request hash, is `pending`,
  or is `retry_wait` with fewer recorded attempts than the journaled attempt (a rollback; a
  `retry_wait` whose attempt was recorded as not dispatched is legitimate);
- a journaled staged call is absent from `staged.sqlite` or is not `executing`/`unknown`/`completed`;
- a journaled staged call is `completed` but its queue record `<stagedId>:0` is absent, has an
  operation other than the staged tool's (`fortnox_create_customer` -> `createCustomer`,
  `fortnox_create_invoice` -> `createInvoice`), or is still `prepared`/`source_in_flight`.

The message says that read-only reconciliation against Fortnox and Accounted is required.

- Registry: `~/Library/Application Support/noxctl-pilot/registry.json` (0600, atomic write with
  fsync of file and directory) maps the real path of each state directory AND its binding
  (`sourceCompany`, `targetCompany`) to its pilot id. It is written at initialization, before the
  journal. Initialization is refused (gate refuses, reconciliation required) when an entry already
  exists for this directory OR this binding, so losing or replacing the whole state directory does
  not start a new pilot beside the surviving head record. A fresh directory with a fresh binding
  initializes normally; a malformed registry also refuses.

What the operator must never delete or edit: `pilot-id`, `journal/`, the head record in
`~/Library/Application Support/noxctl-pilot/`, the queue and `staged.sqlite`. `registry.json` is on that list too. Deleting `pilot-id` and the journal (or the whole state
directory) is detected through the registry and refused. Starting a new pilot for the same
directory or binding is therefore an explicit operator action: abandon the old pilot (use a new
directory and binding), or remove its registry entry and head record by hand, which is equivalent
to abandoning it.

Restore procedure: stop the server; restore `staged.sqlite` and `queue/shadow.sqlite` from a backup
(remove stale `-wal`/`-shm` files); NEVER touch `journal/`, `pilot-id` or the head record; start the
host and run `status` (acknowledges the restore). If the gate then reports a journal refusal, the
restored databases are older than what was really dispatched. Reconcile by hand, read-only, against
Fortnox (was the journaled write made?) and Accounted (does the target object exist?). There is no
command or flag that overrides the refusal; the safe outcomes are to abandon the pilot company and
directory, or to start a fresh directory with a new binding.

## MCP requests: duplicate ids and lock ownership

Every incoming request with an id is registered as in flight (any method), and `tools/call` requests also get a server-generated random token; the pilot lock is owned and released
by that token, never by the client's JSON-RPC id. A request of ANY method whose JSON-RPC id equals
one still in flight on the same connection is answered with a JSON-RPC error (`-32600`) and never reaches a
handler, so it cannot share, take or release the first request's lock. A response removes only the entry of
its own request; the lock is released only when that entry is a staged tool call holding the token.

## Durable backups

A backup reports success only after, in this order: `VACUUM INTO` of both databases, integrity
check, `manifest.json` written, fsync of each copied file and of the manifest, fsync of the backup
directory and of `backups/`, removal of the `backup-pending` marker, fsync of the state directory.
The `backup-pending` marker itself is written, and the file and the state directory fsynced,
before any mutation starts; if that fails the mutation is refused (nothing dispatched) and the
marker stays, so the gate refuses until a backup succeeds. Any backup failure keeps (or re-creates)
the marker and removes the incomplete backup directory. The gate
also reads the newest backup on every check: if its manifest is missing, or its sha256/size values
do not match the files, storage is unhealthy and writes are refused until a new backup succeeds.

## Recovery

- Never delete the queue or `staged.sqlite`; they are the receipts.
- Never retry an unknown outcome. `target_unknown`, `source_unknown` and `source_in_flight` need
  read-only reconciliation against the real systems.
- Abandoning the pilot Accounted company and starting a fresh one (new binding, new directory) is
  preferred over repairing an unresolved pilot state.

### Registry lock

Initialization takes `<headDir>/registry.lock` (exclusive create, never waited on, never stolen) across the registry read, conflict check and update, so two concurrent initializations cannot lose a registration. If it exists and no pilot process is running, the operator removes it by hand after checking. Head-directory files are written through unique temporary names.

## Phase B findings (GRIM-240)

- The deployed Accounted stores 25 % VAT as `vat_treatment = 'standard_25'` and leaves `paid_amount` null on an unpaid draft; the draft readback now accepts exactly that.
- The Accounted company list does not expose a key's per-company access, so a read-only key cannot be detected before the first POST: the POST is refused with 403 and the record becomes `target_unknown` (fail closed). Give the pilot key write access in the pilot company.
- There is no pre-write preflight yet: a Fortnox write whose arguments the mapping refuses (missing InvoiceDate/DueDate/Currency, unsupported customer input fields) sits unmappable at the head of the queue. Phase C requires a preflight before every Fortnox write.
- The synthetic source is shared on disk (`synthetic-fortnox.json`) so the CLI and MCP server see the same records.
