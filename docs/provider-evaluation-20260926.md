# Provider evaluation follow-up: Lundify vs Spiris

**As of:** 2026-09-26 (Europe/Stockholm)
**Scope:** bounded follow-up for issue #176; provider discovery and a prospective sandbox pilot only.
**Decision status:** defer provider-adapter work until access, written terms, and customer demand pass the gates below.

## Evidence boundary

The local baseline is [`docs/accounting-agent-integration-market-report.md`](https://github.com/Magnus-Gille/noxctl/blob/main/docs/accounting-agent-integration-market-report.md), dated 2026-08-29. It identifies Lundify/Björn Lundén as the strongest post-Fortnox commercial candidate and Spiris as technically accessible but commercially weaker because Spiris already operates a first-party MCP. The conductor read the current issue #176 on 2026-09-26; its scope prioritizes a small Spiris REST sandbox pilot after access and terms qualification.

This recheck used public, first-party pages only. No account, credential, sandbox, MCP session, API request, or provider contact was used. The observations below are documentation checks, not empirical availability or quality tests.

## What the public sources establish

### Lundify / Björn Lundén

Björn Lundén’s official event page schedules “Nästa generation av AI i Lundify” for 23 September and says that the platform is being opened with an MCP layer so external AI tools can work directly against Lundify. This is a product announcement on an event page; it does not establish that an external developer can connect today. The page has no MCP URL, OAuth or API registration flow, tool list, rate limits, sandbox instructions, support commitment, or MCP price.

The official developer portal does document a REST API request flow: submit an integration request, accept the REST API terms, and wait for Björn Lundén to assess the request and issue an API key. The official integration guide says the included sandbox company is pre-connected, while real companies require explicit activation. Activation can be performed in Lundify, with an activation key, or through a redirect flow; scopes are accepted by the customer during that flow. These are useful building blocks for an API pilot, but they are not proof that the new MCP layer exposes the same operations or commercial access.

Public Lundify product prices are 199 SEK/month for Easy and 349 SEK/month for Total, for one user and one company, with a 30-day free trial. The public price page does not list a separate MCP fee. The 149 SEK/month “Integrationer” line is listed under the agency add-on table; its relationship to MCP access is unspecified and must not be treated as an MCP price.

**Current assessment:** strategically interesting because the provider is announcing first-party MCP capability and has an API/sandbox/activation model; operationally unconfirmed for an external adapter. Ask Björn Lundén for a private MCP pilot or written confirmation that the REST API is the supported route while MCP access is staged.

### Spiris

Spiris publishes a hosted MCP beta at `https://mcp.spiris.se/mcp`. Its official setup requires an administrator to add the “MCP – Beta” service, enable it per user, and accept the terms. The documented connection uses OAuth. The published first-phase tool inventory covers customers, orders, customer invoices, suppliers, supplier invoices, vouchers, accounts, company summary, attachments, projects, cost centers, and company settings. The page says the beta is free, but a monthly fee will be introduced before general release.

The same page says the beta has no normal support channel; feedback is monitored through the built-in `submit_feedback` tool. It also warns that accounting data travels through the selected AI platform and recommends business-tier AI plans for client work. This documents a hosted MCP test route, while support, future price, AI-provider terms, and production readiness remain explicit pilot risks.

Spiris separately documents a partner API with OAuth2, read-only and full scopes, a sandbox company, and production access by contacting API support. The sandbox is for development and cannot access live production customers. This gives a second route for a controlled adapter comparison, but the first-party MCP reduces the case for building a generic “MCP to Spiris” connector unless noxctl adds materially better CLI, policy, audit, tenant, or workflow controls.

**Current assessment:** first candidate for a bounded REST sandbox pilot after written access/terms qualification; the hosted MCP is a comparison baseline. Do not infer production SLA, final pricing, or support coverage from the beta.

## Concrete prospective user workflow

Use one consenting test company and one named test user per provider. The user asks a local noxctl CLI workflow to:

1. connect the provider account through the provider’s documented OAuth or activation flow;
2. select exactly one company/tenant and show the selected tenant before any operation;
3. read company settings, one customer, one supplier, one invoice, one supplier invoice, and one voucher, with IDs and source provider retained in the audit record;
4. prepare a customer-invoice draft from a fixed fixture, returning a dry-run preview containing the provider object and intended monetary effect;
5. require an explicit user confirmation before creating the draft; never send, post, pay, delete, or finalise during the first pilot;
6. repeat the same request with the same idempotency key and verify that it does not create a duplicate;
7. revoke access, retry, and verify a clear failure with no cross-tenant fallback; and
8. export the audit record and reconcile the provider-side object to the preview.

The draft lifecycle and cleanup must be verified before treating draft creation as reversible. Payments, final posting, invoice sending, payroll, deletion, and multi-company rollout require separate written approval and provider-specific acceptance criteria.

## Provider brief to send after approval

noxctl is an open-source local CLI and MCP server for customer-authorized accounting
workflows. We are evaluating a small adapter that lets a user select one company,
export a repeatable read-only report to JSON, and later preview and explicitly
confirm an invoice-draft creation. We also want to understand whether a future
hosted service is permitted; it is a separate distribution model, not part of this
pilot. Please confirm supported access, terms, customer subscriptions, partner fees,
data-processing obligations, and whether this model conflicts with any distribution
or competing-service restrictions.

The prospective product-value test is a scheduled JSON export of unpaid invoices
and unmatched bank transactions for one company, with stable IDs and reproducible
filters. Validate with a prospective user that scripts and comparison across providers
solve a real need beyond interactive first-party MCP. No user demand has yet been
established in this evaluation.

## Written questions before access or implementation

Ask both providers to answer in writing, with answers distinguishing local open-source CLI/MCP distribution from optional future hosted use:

- Is local open-source CLI/MCP distribution permitted, including user-managed authorization and customer-authorized writes? Is external MCP use allowed for a commercial hosted service, including agent-assisted reads and draft creation? Which automated writes are prohibited or require a human confirmation?
- Is the public MCP endpoint available to third-party developers now? If not, what is the access route, eligibility, expected date, and supported operations?
- Is the supported integration path MCP, REST API, or both? Are the MCP and API contracts versioned and backed by compatibility commitments?
- What sandbox/test-company access, scopes, test data, redirect URLs, rate limits, quotas, webhooks, and production approval steps apply?
- May the integrator store OAuth refresh tokens or API keys in a hosted service, and for how long? What tenant, user, and revocation semantics must be preserved?
- What provider terms, DPA/subprocessor requirements, hosting-region constraints, audit requirements, incident notice, retention, deletion, and support/SLA obligations apply?
- Is there a partner directory, referral, white-label, reseller, or revenue-share route? What fees or minimum commitments apply? Is any public product price an end-customer subscription only, rather than integration access?
- How are breaking changes, deprecations, maintenance windows, and support escalations communicated?

## Pilot acceptance matrix

| Gate | Evidence to collect | Pass condition for a bounded pilot | Current state |
| --- | --- | --- | --- |
| Provider access | Written approval plus sandbox credentials/endpoint | Named test tenant and user can connect without production data | Spiris: public beta route; Lundify: REST API request flow only; MCP access open |
| Contract and terms | Provider terms, DPA/subprocessor answer, AI/MCP use answer | Hosted reads and draft/create use are expressly permitted | Open for both |
| Tenant isolation | Connection metadata and revoke test | Every request is bound to the selected tenant; revoke fails closed | Not tested |
| Read coverage | Provider responses for fixed fixtures | Company, customer, supplier, invoice, supplier invoice, voucher can be read with stable IDs | Spiris: listed in MCP inventory; Lundify: no public MCP inventory |
| Draft/write boundary | Dry-run and create response | Preview precedes create; no send/post/pay/delete path in pilot | Open; provider semantics must be confirmed |
| Confirmation and audit | Request, preview, approver, result, provider ID | Explicit confirmation and replayable audit record for every mutation | Open; no runtime test done |
| Retry/idempotency | Repeated request and provider result | Retry cannot silently duplicate a draft | Open; provider support must be documented or guarded |
| Rate limits and failures | Provider limits, errors, maintenance/support route | Limits, token expiry, revoke, and non-2xx errors are actionable and observable | Spiris public beta support caveat; Lundify open |
| Pricing | Written pilot and post-beta price terms | Pilot cost and likely recurring integration/customer cost are known | Spiris MCP free in beta only; Lundify MCP price not published |
| Distribution | Partner/catalogue terms | There is a permitted customer onboarding path that does not require bespoke provider intervention per tenant | Lundify has documented activation paths; Spiris admin activation documented |

## Recommendation and defer point

Qualify a read-first Spiris REST sandbox pilot for issue #176 and use the first-party MCP beta as a documented comparison, while separately requesting Lundify’s MCP endpoint, tool schema, access terms, and pilot invitation. Keep Lundify in commercial discovery because its first-party MCP announcement could make it the more strategic provider, but do not infer availability from the 23 September event listing. Do not start a full adapter for either provider until the written terms gate, tenant/revocation gate, and at least one customer or partner demand gate pass. If Björn Lundén cannot provide MCP access or a supported REST route with acceptable hosted terms, defer Lundify and retain Spiris only as a comparison/pilot target rather than committing to a provider-neutral architecture.

## Sources checked (official)

- Björn Lundén, event programme and MCP-layer announcement: <https://bjornlunden.com/se/ekonomi-foretag/>
- Björn Lundén developer portal, API key request and assessment flow: <https://developer.bjornlunden.se/get-started/>
- Björn Lundén developer guide, sandbox and company activation: <https://developer.bjornlunden.se/topic/press-news/>
- Björn Lundén public prices: <https://bjornlunden.com/se/priser/>
- Spiris hosted MCP beta, operations, onboarding, privacy, support, and pricing: <https://developer.vismaonline.com/docs/spiris-mcp-server>
- Spiris API onboarding and production access: <https://developer.vismaonline.com/docs/spiris-eaccounting-api-documentation>
- Spiris OAuth scopes and flow: <https://developer.vismaonline.com/docs/authentication>
- Spiris sandbox boundaries: <https://developer.vismaonline.com/docs/environments>
