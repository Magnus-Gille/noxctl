# Embedded runtime API

`noxctl/embedded` is the supported package entry point for applications that host noxctl's Fortnox operations or MCP tools inside their own Node.js runtime. It is separate from the local CLI/profile flow: the host supplies one already-authorized token context, and noxctl binds an isolated client, operation set, and MCP server to it.

## Trust boundary

The host must authenticate the caller and select the Fortnox tenant **before** constructing the noxctl transport. Tenant identity, profile names, access tokens, and token-provider selection must never come from model-controlled MCP tool arguments.

```ts
import { createFortnoxClient, createServer } from 'noxctl/embedded';

async function createTenantServer(authenticatedSession: AuthenticatedSession) {
  // tenantKey and diagnosticId come from trusted server-side session state.
  const transport = createFortnoxClient({
    getAccessToken: () => tokenVault.getValidAccessToken(authenticatedSession.tenantKey),
    contextLabel: authenticatedSession.diagnosticId, // non-secret; errors only
  });

  return createServer({ transport });
}
```

The MCP schemas deliberately contain no tenant, profile, or token-routing fields. An embedded server requires `{ transport }` and omits the local `fortnox_status` tool because that tool inspects the machine's local profile and keychain. Only the legacy root API's zero-argument `createServer()` preserves the local stdio-compatible tool set.

## Lifecycle and concurrency

- Create one `FortnoxTransport` for one authorized tenant context. Never reuse it for another tenant.
- A transport owns its token provider, diagnostic context, request queue, and rate-limit state. Concurrent transports do not share those values.
- It is safe to reuse a transport for multiple sessions only when they are authorized for the same Fortnox tenant and share the same policy boundary.
- Create an MCP server from that transport, connect it to the host's chosen MCP transport, and close the MCP connection when the session ends.
- Keep `contextLabel` non-secret. It is sanitized and included only to distinguish errors; it is not an authorization input.

The package also exports `createFortnoxOperations(transport)` for hosts that need the typed operation layer without MCP.

## Host responsibilities

The embedded API does not provide a hosted product. The host remains responsible for:

- Fortnox OAuth callbacks, consent, token refresh policy, encrypted token storage, revocation, and scope management;
- user authentication, authorization, tenant/session routing, CSRF protection, and abuse controls;
- databases, queues, domains, deployment, monitoring, backups, incident response, and support;
- confirmation policy for mutations, audit trails, idempotency, and recovery from unknown mutation outcomes;
- privacy, GDPR roles and agreements, retention, log redaction, data-subject processes, and any transfer assessments;
- subscriptions, metering, quotas, invoices, taxes, refunds, and Fortnox App Market obligations.

Never log access tokens or raw accounting/payroll payloads. Keep raw MCP output opt-in, and preserve noxctl's `confirm: true` and `dryRun` controls for mutations.

## Supported exports

The `noxctl/embedded` entry point intentionally uses an allowlist. It exports:

- `createFortnoxClient` and its transport/options/error types;
- `createFortnoxOperations` and `FortnoxOperations`;
- `createServer` and `CreateServerOptions`.

It does not export local auth, profiles, keychain functions, CLI startup, `startMcpServer`, or the local default transport/operations. Its `createServer` requires a transport and fails closed if one is missing.

The package retains its older root and `dist/*` entry points for local-CLI and deep-import compatibility. Those paths are not an isolation boundary and must not be used by hosted integrations; embedded hosts must import only `noxctl/embedded`.

The embedded surface is versioned with the `noxctl` npm package. Release checks pack the real tarball and verify both runtime and TypeScript consumption through `noxctl/embedded`.

## Explicit invoice payment adapter

The local evaluation candidate exports `AccountedInvoicePaymentAdapter`, `InvoicePaymentPlan`
and `CapturedPaymentVoucher` through `noxctl/embedded`. The host supplies its company binding,
durable queue snapshot, captured source voucher lookup and target request callback. There is
no default worker, credential lookup, source voucher fetch or automatic live activation.

This lane covers full settlement of ordered domestic CASH/SEK product invoices with
25 percent VAT and an exactly matching captured voucher. Input and confirmed source rows
must match position by position. Units are preserved exactly (an empty unit stays `''`; padded, whitespace-only and control-character units are refused); positive integer quantities,
cent prices and source/target per-item and aggregate amounts must agree. Target item readback
uses unique IDs and contiguous `sort_order` positions for multiple rows instead of trusting
the returned array order. Historical single-item receipts keep their existing expected shape.

Captured payment credits may be split or coalesced per confirmed revenue account and VAT;
the complete original line array is sent and verified without merging or dropping rows.
Discounts, dimensions, zero/negative/text rows, other VAT rates,
FX, partial payments and credit flows remain unsupported. Arithmetic mismatches are refused
before target dispatch rather than silently changing amounts. The
adapter checks the persisted issued invoice, performs a noncommitting preview, then one commit.
It retains a returned payment-row ID separately from invoice and journal IDs. Complete receipts
with failed readback can reconcile with GETs only; contradictory receipts and receipt-less
unknown outcomes must not be replayed. Native atomicity, target API deployment and actual-client
acceptance still need verification before a live pilot. An exported callback API grants no
permission to access accounts or execute financial operations.

## Staged writes with durable request IDs

`createStagedServer` is an opt-in embedded factory for hosts implementing the explicit prepare/execute workflow. It does not start a listener, authenticate a user, read a saved login, install a client or enable CLI shadow mode. The host must supply one authenticated caller context and one tenant-bound transport.

```ts
import { createStagedServer } from 'noxctl/embedded';

const staged = await createStagedServer({
  transport: tenantTransport,
  directory: privateHostDirectory,
  actorId: authenticatedActorId,
  binding: { sourceCompany, targetCompany },
  revision: verifiedArtifactSha256,
  maxPreparationAgeMs: 15 * 60 * 1000,
  authorize: (context) => hostPolicyAllows(context),
});
// Connect staged.server only to the authenticated caller transport.
// A trusted host may use staged.queue with an explicitly approved target worker.
// When no execute call is active: await staged.close().
```

The callback must return literal `true` for each prepare, execute, get, list and status request. Execution checks it again before source dispatch. Cached responses still require current authorization. The caller cannot select an actor, company, path or revision through tool arguments. These host declarations are not authentication or artifact attestation; the embedding application must establish them. The fixed actor, company pair, revision and preparation lifetime are persisted, and mismatched reopen is refused.

The exposed tools are `staged_prepare`, `staged_execute`, `staged_get`, `staged_list` and `fortnox_shadow_status`. Only customer and invoice creation are initially supported. Preparation validates the actual registered tool schema and persists normalized arguments without dispatch. It requires `confirm: true` and no dry run inside the business arguments. Execution separately requires `{ id, confirm: true }` and a preparation that has not expired. A deliberate second identical operation needs a new preparation ID. After reconnect, retrieve the original ID instead of preparing another write.

New execution is refused on expiry or clock rollback before preparation. A completed MCP response can still be read or replayed after expiry if currently authorized. Successful MCP responses are preserved exactly. Error responses from the inner SDK are normalized before storage or return so raw host diagnostics cannot leak. A completed error response remains an error; it is not target parity. Source/outer-response persistence gaps stay unresolved and never trigger automatic replay. Source operations use child identity `outerID:0`; this version rejects an unexpected or additional observed write before invocation. Multi-write tools are not supported.

Input is limited to 64 KiB and the outer result to 2 MiB. An oversized result after a source effect is unresolved; inspect the trusted queue receipt, never repeat the effect blindly. History uses numeric cursor pagination (default 25, maximum 100) and returns summaries without arguments/results. Get retrieves one full saved record. Shadow status uses `queue.summary()` to return aggregate counts and lag from one database snapshot, decoding at most the oldest unapplied receipt instead of the full history. The legacy `queue.status()` still returns its complete item list. Summary queries still scan queue metadata and are not a latency or storage quota. Storage must be private and owned by the host user. The process and its parent filesystem path must also be protected by the embedding host; same-UID hostile file mutation is not isolated by this API.

No recovery mutation is exposed. Preserve receipts when changing artifacts or policy; revision mismatch needs an explicit migration/recovery plan, not deletion of the store. The local synthetic checks do not prove configuration or behavior in installed Codex, Claude Code, OpenCode or Pi clients.

## Durable article identity lookup

The local evaluation queue supports `resolveIdentity('article', sourceArticleNumber)`.
It derives identity only from a persisted `createArticle` source receipt's exact
string `ArticleNumber` and an applied target receipt that confirms the saved UUID.
Leading zeros and case are preserved. Numeric article numbers are not coerced.
Company mismatches, conflicting creators, missing receipts and unknown outcomes
remain non-ready under the existing identity rules. Lookup makes no provider/network calls; the queue reads its SQLite store.

This adds a receipt lookup, not an Accounted article creation adapter or a historical
import crosswalk. It does not enable article creation in the staged MCP allowlist,
change target catalog values, or allow article-linked invoices through the current
invoice mapper. A host still needs a reviewed article adapter and verified target
API/data model; absent source price/unit must not silently become zero/st.
