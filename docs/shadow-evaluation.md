# Local Fortnox-first shadow evaluation

This is an opt-in development candidate, disabled by default. It has not been
published or activated against a real account. Fortnox remains authoritative.
No credentials or Accounted HTTP client are included. No live migration or
financial-parity claim follows from an empty queue.

## Scope and coverage

CLI and MCP business operations share an explicit operation catalogue and an
optional observer. Confirmation and dry-run handling still run first. Reads do
not enqueue. GET-shaped send/print actions are classified explicitly as writes.
Unobserved attachment batches keep the existing behavior: validate all paths up front, then read each file at its upload turn. Observed uploads and attachment batches capture private copies of file bytes and names before claiming the intent and upload those exact bytes. Replacing a path or changing the working directory cannot silently change an existing intent. The canonical record limit is 32 MiB (including encoded bytes); larger inputs fail before source dispatch.

Nested calls inside one business operation form one intent; partial failure of
such an operation is an unknown source outcome, never an automatic retry.

The initial customer translation is `createCustomer` for a confirmed
Swedish business with `Type: COMPANY`, `CountryCode: SE`, a source customer number
and name. Customer numbers must already be unpadded and at most 32 characters; email must satisfy the native target schema. Supported explicit input fields are Name, Type, CountryCode,
CustomerNumber, OrganisationNumber, Email, Phone1, Address1, Address2, ZipCode,
City and VATNumber. Only requested optional fields are translated. Provider
defaults and other returned fields remain in the source receipt; this is not full
customer-field parity. TermsOfPayment is a Fortnox reference code, not a verified
number of days, and is deliberately blocked. Other input fields, customer types,
countries and operations become visible blocked records.

`AccountedMasterDataAdapter` adds a limited `createSupplier` translation and binds
both source and target companies. The host must explicitly classify each confirmed
Fortnox supplier number as `swedish_business`; country alone never establishes this.
The classification map is copied at construction. An unclassified supplier pauses
ordered target work. After supplying an approved mapping to a new adapter, the host
can call `revalidateBlocked(id, adapter)`: it accepts only a mapping-blocked record
with zero target attempts and no target identity/receipt. It rechecks the pure
translation and returns the unchanged source evidence to pending. It cannot reset
an unknown outcome, a dispatched attempt or an applied-record readback mismatch.
Only Name, CountryCode, Email, Phone1, Address1, Address2, ZipCode, City,
OrganisationNumber and VATNumber can be requested. OrganisationNumber must already
be ten digits, with no implicit canonicalization. Explicit SupplierNumber is blocked
because the native target has no writable supplier-number field. The source number
remains in the durable receipt and the native UUID in targetId. Bank/payment fields,
terms, currencies and all other explicit fields are blocked. Native defaults are not
source parity; the supplier's default 30-day terms and SEK are not asserted equal.

Both adapters use the same single-POST/exact-ID-GET implementation. The master-data
adapter has fixed customer/supplier routes and exposes no arbitrary target path.
These routes do not directly send invoices, pay, submit tax returns or post payroll.
However, native customer/supplier events can invoke configured outbound webhooks.
A live host must independently verify disabled hooks/egress and evaluate event
subscribers before enabling even this narrow pilot.
Invoice rows that carry an `ArticleNumber` are mapped only when the opaque number
(never parsed; leading zeros and case preserved) resolves through an applied
`createArticle` receipt to a target UUID. The draft body then sends that UUID as
`items[].article_id` while keeping the source row's own description, quantity, unit
and price, because the target does not fill those from the article. Unlinked rows
omit `article_id` and must read back as null; the UUID is part of the receipt
`expected` content that the draft, issue and stage verifiers compare. An unmapped,
unresolved/unknown-outcome, conflicting or malformed article identity refuses the
row with an `ARTICLE_*` reason and nothing is dispatched. Empty units and
non-positive quantities remain refused.
Experimental strict invoice draft and issue adapters are described below and remain
unwired. There are no voucher, document, article or payment replay adapters yet.
The reviewed native v1 article surface is read-only; an MCP create tool does not
establish a REST creation contract. Historical
SIE-backed invoices must not be recreated with new payment journals.

A valid UUID in an unexpected create response is retained as a reported possible
identity. An unexpected HTTP status or mismatched mapped fields produces an
explicit incomplete receipt and leaves the queue in `target_unknown`. The receipt
contains the observed status, actual data and expected mapping. No follow-up GET
or repeated POST runs on that path. A later matching read cannot promote the
incomplete response. It needs operation-specific investigation.

A matching HTTP 201 create receipt followed by failed readback remains a separate
case: its known identity and complete legacy receipt can be reconciled with GET
only. Receipt identity and mapped fields are checked before any target read.
Responses without a valid UUID do not gain an invented identity from this change.

## Durable state and retries

The opt-in queue needs a Node runtime exposing `node:sqlite` (tested with Node
26.12.1). SQLite is lazy-loaded, so default operation does not require that
feature. Use a private, owned 0700 directory on a local filesystem supporting
SQLite WAL and durable fsync. Do not put the queue on network/cloud-sync storage.
The database is 0600. It contains business inputs, source receipts and target
receipts in plaintext; keep it on an appropriately protected disk.

All observed business arguments are copied before an asynchronous observer can yield, so later caller mutations cannot diverge from the stored request.

Each queue is permanently bound to one source company and one target company.
Intent IDs are stable host-supplied command/request identities. The canonical
hash includes both companies, operation, arguments and schema version. Binary
and undefined values round-trip without JSON type collisions; oversized or
unsupported input fails before source dispatch. Reusing an ID with another
payload fails. A separate intent with identical data is a distinct operation.

SQLite commits the source claim before calling Fortnox. Confirmed source results
are durably saved before return and can be returned again for the same intent.
Accounted is never called on the synchronous Fortnox path. Target failures do not
prevent new source operations. If receipt persistence fails after source success,
the error explicitly says that Fortnox succeeded and must not be repeated.

States shown in status:

| State | Meaning / safe next action |
| --- | --- |
| prepared | Stored intent, no dispatch claim |
| source_in_flight | Claimed source call; after interruption, treat as unknown |
| source_unknown | Source outcome needs operation-specific readback |
| pending | Confirmed source receipt waiting for target |
| retry_wait | Host proved no target mutation was dispatched; retry after nextAttemptAt |
| target_in_flight | Claimed target call; after interruption, treat as unknown |
| target_unknown | Target may have changed; do not retry create |
| blocked | Unsupported semantics or readback drift requiring resolution |
| applied | Target identity and verified receipt durably recorded |

`drainOne` advances the oldest unresolved intent only. A blocked or unknown item
pauses later target work to preserve dependencies. Source work can continue.
The host owns scheduling. There is no background daemon or automatic startup.
For a proven pre-dispatch outage the trusted callback may throw
`TargetNotDispatchedError`; backoff is persisted and grows from 1 to 60 seconds.
Never use this error for a dispatched request, timeout, HTTP 429 or uncertain
failure. A failed readback after successful POST cannot be classified this way.

Accounted's best-effort 24-hour idempotency cache is not a durable exactly-once
mechanism. The adapter makes one POST attempt with a stable idempotency key,
then verifies the returned identity via GET. It never blindly repeats an unknown
create, even within the cache TTL. If a valid create receipt exists but readback
fails, preserve its target identity and resolve with `reconcileTarget`, which
uses GET only. Unknown outcomes without a durable identity stay paused. There
is intentionally no generic force-retry/mark-success switch. Source-specific
reconciliation for unknown Fortnox writes remains future work.

## Local CLI capture

An operator-owned configuration file contains exactly these fields, no secrets:

```json
{
  "version": 1,
  "profile": "evaluation",
  "sourceCompany": "exact OrganizationNumber from Fortnox companyinformation",
  "targetCompany": "Accounted company UUID",
  "directory": "/absolute/private/shadow-queue"
}
```

The resolved profile must match. Before each confirmed business mutation, the
CLI reads Fortnox companyinformation and verifies OrganizationNumber exactly.
No source read occurs for dry runs or missing confirmation. Writes also require
`--shadow-intent <stable-unique-command-id>`. Multi-operation commands append an
ordered index; reuse an ID only for the identical command and arguments.
This configuration is a host/operator decision, not an MCP tool argument.

`noxctl shadow status` reports disabled when no configuration is supplied.
`noxctl --shadow-config /path/to/config.json shadow status` shows the bound queue,
counts, oldest unapplied age, blocked/unknown reasons and target identities.
Configured commands also print a concise lag summary on stderr. Removing the
flag disables future capture and preserves the database; stopping a worker
preserves all pending evidence. Never delete a queue to resolve unknown effects.

CLI capture does not run an Accounted worker. Local `serve` with this configuration
is refused because it lacks stable host request identities. Use the explicit
embedded interface for MCP evaluation instead.

## Embedded host contract

`noxctl/embedded` exports `openShadowQueue`, `createQueueObserver`,
`AccountedShadowAdapter`, `AccountedMasterDataAdapter`, `TargetReceiptPendingError`
and the error/types needed by a host. Bind a verified
source-company transport and matching queue before `createServer({ transport,
observer })`. The host supplies stable per-request operation IDs through
`createQueueObserver(queue, intentIdProvider)`; concurrent requests must not
share an ID unless they are deliberate retries of the same intent. The queue
records an already-authorized operation; it does not grant business authority.
Direct operation API callers must enforce their own confirmation policy.

`TargetReceiptPendingError` carries `targetId` and `receipt` when creation
succeeded but readback is unresolved. A host catching it must preserve that
evidence and reconcile by reading the known target, without repeating creation.

The injected Accounted request callback must bind a fixed authorized origin and
company, attach its own credentials, prohibit redirects to another origin and
perform no automatic mutation retries. Neither source/target selectors nor
credentials are accepted as model-controlled business-tool arguments. Never
attach one queue to transports for different companies. The optional MCP tool
`fortnox_shadow_status` accepts no selectors and exposes only this bound queue.

Live arming, credential setup, publication and any new adapter require their own
reviewed scope. Recovery is to stop capture/worker, retain the queue, inspect
source and target identities, and reconcile read-only before proposing action.

## Source-to-target identity lookup

`queue.resolveIdentity(resource, sourceId)` reads a fresh SQLite snapshot of creator
receipts. It adds no second database or mapping cache and performs no provider call.
Resources are customer, supplier, invoice and invoice-payment. Creator operation
and source receipt field are fixed; updates, sends and bookkeeping receipts never
replace a creation mapping. Both companies must match the queue binding.

The result is `ready` only for one applied creator with a valid native target UUID
and a matching persisted `receipt.data.id`. Pending/unknown/drifted records are
`unresolved`; multiple creators or a target UUID claimed for another source of the
same resource are `conflict`. An unidentified creator claiming the same target
also blocks lookup. A `missing` result never authorizes another create. Source
string IDs remain exact, including leading zeros and case; positive safe numeric
receipt IDs become decimal strings. Opaque IDs must not be guessed from names.

Each call reconstructs the mapping from durable queue rows, including after a
process crash or a write from another connection. The UUID is evidence of the
previously accepted receipt, not a fresh guarantee about remote state. Hosts must
still use operation-specific readback and preserve unknown outcomes. This API
does not add native invoice/payment replay adapters or enable financial writes.

The experimental invoice issue adapter is intentionally unarmed and exported only
through the embedded API. It accepts only `markInvoicePrinted` receipts with
`confirmed: true`, matching `DocumentNumber`, `Sent: true`, and the exact
`invoice`/`confirmed`/`pdf` envelope. The PDF may be undefined; when present it
must be a nonempty Buffer. It requires an
applied strict CASH/SEK draft creator resolved from durable identity evidence.
It conservatively rejects every source receipt difference except `Sent`,
revalidates the strict mapping, reads the target draft, and makes one
`mark-sent` POST. Success requires HTTP 200, the matching sent invoice and total,
a nonempty invoice number, explicit `journal_entry_id: null`, no warnings,
and expanded readback with unchanged supported fields and items.

Complete mutation receipts can recover from a failed expanded readback with GET
only. Missing, warning-bearing, malformed, or journal-bearing responses remain
unresolved even if a later GET says sent. GET omits the journal pointer and
warning history. Target accounting settings and event subscribers are not
controlled by this adapter: mark-sent can post a journal and emit outward
webhooks. This local implementation has synthetic evidence only and must not be
armed without separate native prerequisites. The read-only stage verifier below selects the supported current receipt;
full cross-operation lifecycle coverage remains incomplete. `sendInvoice`, email, payments, credits and broader
invoice variants remain outside this adapter's scope.


## Read-only current invoice stage

`AccountedInvoiceStageVerifier` accepts the fixed company binding, a host-owned
`() => queue.snapshot()` callback and an injected request callback. It selects
one applied ordinary invoice creator and, when present, one applied supported
issue receipt. It checks the strict draft or sent projection using existing
adapters. The returned intent ID and sequence identify the selected receipt.
It never drains, reconciles, retries or changes queue records, and permits only
GET requests. No HTTP client or automatic invocation is added.

Unknown later invoice/payment/attachment relationships, unsupported transitions,
duplicate issues and incomplete evidence prevent verification. Matching mutations
before creation are contradictory. Ambiguous older records do not describe a
later transition. A changed queue snapshot during readback returns `stale`, even
when the concurrent record is unrelated. Results describe a bounded observation;
they do not establish atomic consistency or complete accounting parity. Financial
parallel execution remains unarmed and requires separate native verification.

An optional fourth constructor argument receives private diagnostic errors with
the original cause. Hosts must keep that callback separate from user-visible
reports and redact sensitive transport details before persisting diagnostics.
Public summaries contain bounded reasons and IDs, not raw errors or payloads.

### Source payment lifecycle projection

`projectInvoicePaymentLifecycle(queue.snapshot(), binding, sourcePaymentId)` is a
read-only view of captured source receipts. It reconstructs create, update,
bookkeep and delete for one payment, retaining sequence and intent identities
across interleaved operations. Only an actual boolean `Booked: true` receipt
establishes its `booked` source state. An unbooked creation stays
`waiting-for-bookkeeping`; missing evidence, unknown outcomes and conflicting
identities remain explicit. `snapshotHash` binds the input snapshot for a future
staleness check, but does not authenticate receipts or authorize execution.

Projection does not change queue counts or dispatch anything. In particular,
source `booked` is not target `applied`, and source `deleted` does not delete a
target record. The explicit generic queue mode below coordinates deferred
preparation and grouped receipts, while the Accounted financial adapter and its
native journal/readback verification remain unimplemented. Default strict replay
and disabled financial parallel writing are unchanged.

### Explicit payment-aware queue execution

A host can opt into `drainPaymentAware(normalAdapter, paymentAdapter)`. It is not
wired into the CLI, MCP server or default financial replay. The host still must
supply and authorize a real target adapter; the generic callback contract and
synthetic tests are not a deployed Accounted payment capability.

Unbooked create/update preparation becomes `deferred`, remains visible in lag,
and has no target receipt. The method can pass those validated preparations to
process intervening normal work, then dispatch one payment at its terminal
source position. A group ID binds the entire ordered source chain; its durable descriptor also
binds the prepared request hash. Claim, success, unknown receipt and reconciliation update every
member atomically. A source deletion before any target attempt completes the
whole unbooked chain as `source_cancelled`, without calling the target. These
terminal records remain in historical status items, but do not increase active
lag. The two states are additive; older runtimes must not be used to resume this
queue while payment-aware work is present.

`drainOne` retains its original mode and never skips deferred or grouped records.
Old per-record revalidation, reconciliation and readback cannot change a managed
member independently. `reconcilePaymentGroup` uses only an already durable
receipt and requires literal `true` from a read-only verifier. It rejects changed
member evidence after the asynchronous read. `verifyPaymentGroup` blocks the
whole applied group on drift. A timeout or interrupted process is never an
automatic retry; a proven before-dispatch failure retains its group and schedules
a bounded retry, which also requires the same prepared request hash.

Each call advances at most one preparation, normal operation or whole target
group. `idle` means no positive progress was reported. An ordinary attempt can still
have changed to blocked, retry or unknown; an existing unknown/in-flight record
can also stop progress. Inspect status counts and reasons for the retained state.
The caller must not interpret idle as completion. Snapshot-based planning still
uses the existing bounded canonical codec; large-history streaming and complete
financial target mapping/readback remain separate acceptance work.
