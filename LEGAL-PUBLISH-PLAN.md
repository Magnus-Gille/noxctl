# Legal And Publication Hardening Plan

## Goal

Make the repository safe to publish publicly as an open source Fortnox CLI/MCP project, without implying legal or tax guarantees that the current implementation cannot support.

## Non-Goals

- Ship marketplace-ready Fortnox distribution in this pass
- Provide legal advice inside the product
- Expand accounting functionality beyond what is needed to reduce legal and publication risk

## Main Risks To Address

1. Public repo contains live business metadata and customer/contact information.
2. MCP/AI usage can move accounting and personal data into third-party AI transcripts.
3. Current positioning is stronger than the implementation supports for Swedish VAT/declaration use.
4. Fortnox Developer Agreement fit is unclear for a local CLI/MCP product.
5. Public docs do not yet separate "open source repo" from "Fortnox marketplace app" expectations.

## Workstreams

### 1. Remove publish-time data leakage

- Remove or sanitize `STATUS.md` and `PLAN.md` from the public repo.
- Replace real names, emails, organisations, invoice references, and internal business context with synthetic placeholders.
- Review tests and docs for real-looking company identifiers and replace anything that should not be public.
- Add or tighten ignore rules for local operational files if they should remain private.

Acceptance:

- No live customer, supplier, invoice, or internal business data remains in tracked files.

### 2. Add privacy and AI handling disclosures

- Add a `PRIVACY.md` or `SECURITY.md` section specifically for MCP/AI data handling.
- State clearly that using the MCP server with Claude or other AI tools may transfer accounting data and personal data to third-party processors.
- Warn that `includeRaw` can expose more personal/accounting data than summarized output.
- Keep `includeRaw` opt-in and add stronger tool/README warnings around it.
- Clarify that the user is responsible for GDPR, processor agreements, and transfer assessments in their own environment.

Acceptance:

- Public docs explain the privacy model and call out `includeRaw` risk explicitly.

### 3. Narrow tax and accounting claims

- Change wording from "tax declaration support" to "informational VAT summary" unless the implementation is strengthened materially.
- Add a prominent disclaimer that figures must be reconciled against Fortnox's own VAT/moms reporting and the user's accounting records before filing.
- Document the current VAT report limitation: fixed VAT account mapping and no claim of complete Swedish tax compliance.
- Review invoice/bookkeeping docs so they describe operational capability, not legal correctness.

Acceptance:

- No public doc implies the tool is declaration-ready, accountant-approved, or legally sufficient by itself.

### 4. Clarify Fortnox relationship and terms boundary

- Add an "Unofficial / not affiliated with Fortnox" notice.
- State that users need their own Fortnox account/app credentials and must comply with Fortnox's own terms.
- Separate two use cases in docs:
  - self-hosted open source use with the user's own Fortnox app
  - future marketplace/commercial distribution, which has extra Fortnox requirements
- Add a maintainer note that Fortnox Developer Agreement fit for local CLI/MCP distribution is not yet confirmed.

Acceptance:

- Repo no longer reads as an official Fortnox integration or as if Fortnox has approved it.

### 5. Resolve the Fortnox contractual gray area

- Contact Fortnox developer support with a narrow written question:
  - whether a locally run CLI/MCP client that uses the official API via a user's own app is allowed under the current Developer Agreement
  - whether publication as open source is acceptable when the maintainer is not distributing shared credentials
- Do not market broadly or claim Fortnox compatibility beyond the official API behavior until that clarification exists.
- If Fortnox says marketplace/app partner terms apply, capture those requirements in a follow-up publication checklist.

Acceptance:

- We have a written Fortnox answer or we deliberately limit the distribution language to self-hosted/experimental use.

### 6. Tighten public-facing onboarding

- Review prerequisites in `README.md` against current Fortnox activation/licensing requirements.
- Add a short section covering what users must arrange themselves:
  - Fortnox account
  - app registration
  - required scopes
  - any Fortnox licensing/integration prerequisites
- Add a publication-safe example set with synthetic customers, invoices, and suppliers only.

Acceptance:

- Onboarding docs are accurate enough that they do not misstate Fortnox prerequisites.

## Suggested Execution Order

1. Sanitize publish-time data and docs.
2. Add privacy and unofficial-product disclosures.
3. Downgrade tax/compliance claims in tool descriptions and README.
4. Re-check docs against current Fortnox prerequisites.
5. Send Fortnox clarification request.
6. Decide whether the repo is ready for public GitHub only, npm publication, or marketplace work.

## Deliverables

- Sanitized public docs
- Privacy/AI handling notice
- Revised tax wording and disclaimers
- Fortnox affiliation/terms disclaimer
- Short maintainer checklist for final publication review

## Publication Decision Gate

Public GitHub publication can proceed when all of the following are true:

- No live business or customer data remains in tracked files
- README no longer over-claims tax/compliance support
- Privacy implications of MCP/AI use are disclosed clearly
- The repo states it is unofficial and that users must comply with Fortnox terms
- Any unresolved Fortnox agreement ambiguity is disclosed and the product is positioned conservatively
