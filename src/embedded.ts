/**
 * Supported API for hosts that bind one authorized Fortnox transport context
 * before exposing MCP tools. Model-controlled tool arguments cannot select it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FortnoxTransport } from './fortnox-client.js';
import type { OperationObserver } from './shadow/types.js';
import { createServer as createLocalServer } from './index.js';

export {
  createFortnoxClient,
  FortnoxApiError,
  FortnoxRequestTimeoutError,
  type CreateFortnoxClientOptions,
  type FortnoxRateLimitOptions,
  type FortnoxResponse,
  type FortnoxTransport,
  type RequestOptions,
} from './fortnox-client.js';
export { createFortnoxOperations, type FortnoxOperations } from './operations/index.js';
export type { OperationObserver } from './shadow/types.js';

export interface CreateServerOptions {
  /** Host-authorized transport for exactly one tenant context. */
  transport: FortnoxTransport;
  /** Optional host-owned observer for the same tenant-bound operation set. */
  observer?: OperationObserver;
}

/** Create an MCP server that fails closed unless one tenant transport is bound. */
export function createServer(options: CreateServerOptions): McpServer {
  if (!options?.transport) {
    throw new Error('The embedded MCP server requires a tenant-bound transport.');
  }
  return createLocalServer({ transport: options.transport, observer: options.observer });
}

export { openShadowQueue, ShadowQueue, SourceReceiptPersistenceError } from './shadow/queue.js';
export type { ShadowIdentityResolution, ShadowResourceKind } from './shadow/identity.js';
export { AccountedInvoiceDraftAdapter } from './shadow/invoice-draft-adapter.js';
export {
  AccountedInvoiceIssueAdapter,
  type InvoiceIssuePlan,
  type InvoiceIssueReceipt,
} from './shadow/invoice-issue-adapter.js';
export {
  AccountedInvoicePaymentAdapter,
  type InvoicePaymentPlan,
} from './shadow/invoice-payment-adapter.js';
export type { CapturedPaymentVoucher } from './shadow/payment-source-mapping.js';
export {
  AccountedInvoiceStageVerifier,
  type InvoiceStageState,
  type InvoiceStageVerification,
  type InvoiceStageVerified,
  type InvoiceStageUnverified,
} from './shadow/invoice-stage-verifier.js';
export { createQueueObserver } from './shadow/observer.js';
export { AccountedArticleLinkAdapter } from './shadow/article-link-adapter.js';
export {
  AccountedShadowAdapter,
  AccountedMasterDataAdapter,
  type AccountedRequestCallback,
} from './shadow/accounted-adapter.js';
export type {
  ShadowBinding,
  ShadowAdapter,
  ShadowRecord,
  ShadowStatus,
  ShadowSnapshotEntry,
  ShadowPaymentAdapter,
  ShadowPaymentGroup,
  PaymentDrainResult,
} from './shadow/types.js';

export {
  TargetBlockedError,
  TargetNotDispatchedError,
  TargetReceiptPendingError,
} from './shadow/types.js';

export {
  createStagedServer,
  type CreateStagedServerOptions,
  type StagedAuthorizationContext,
  type StagedServer,
} from './staged-server.js';

export { projectInvoicePaymentLifecycle } from './shadow/payment-source-lifecycle.js';
