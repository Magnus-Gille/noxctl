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
