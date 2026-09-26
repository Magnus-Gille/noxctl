# E-invoice readiness

`noxctl invoices preflight <documentNumber>` and `fortnox_preflight_invoice`
read an existing invoice and its customer through the configured Fortnox transport.
The CLI JSON envelope is `InvoicePreflight`; MCP returns the same result as JSON
text and `structuredContent`.

This is a conservative draft preflight, not a complete e-invoice validator. It
always returns `ready: false` while the recipient connection and effective route
cannot be verified through a supported interface. Exit code zero means that the
inspection succeeded, **not** that the invoice is ready. Scripts must inspect
`ready`, `status`, and `issues`.

```sh
noxctl -o json invoices preflight 1001
```

The result separates:

- `observed`: persisted invoice flags, buyer references, available GLN fields,
  invoice EDI status, and customer delivery default read back from Fortnox.
- `draft.status`: `verified` only when sent, booked, and cancelled are explicitly
  false; `unknown` when those fields are absent or malformed.
- `recipientConnection` and `peppolAddress`: `unsupported`, with stable reason codes.
- `effectiveDeliveryMethod`: `unknown`; a customer default or invoice EDI status
  is not proof of the recipient connection or this invoice's future delivery route.
- `issues`: machine-readable codes, severity, and explanations. A sent, booked,
  or cancelled invoice, or missing customer binding, makes overall status `blocked`.

No send, print, activation, invitation, bookkeeping, PDF, or browser action is part
of this command. Read failures propagate as errors. Reads are sequential, not an
atomic snapshot; state can change after inspection.

## Upstream investigation — 2026-09-26

The current public [Fortnox API documentation](https://apps.fortnox.se/apidocs)
was fetched to the ignored local cache. Inspection found no Peppol-address schema
field and no documented recipient-discovery or connection-status operation.
The invoice e-invoice action is a **send operation despite using HTTP GET**;
preflight must never call it. No private website endpoint or browser session is
used as a substitute. This is evidence about the inspected public API, not proof
that Fortnox has no partner interface.

Fortnox's [activation guide](https://support.fortnox.se/produkthjalp/fakturering/aktivera-skicka-e-faktura-till-foretag)
describes recipient activation and invitations separately from sending. A pending
invitation can result in a different delivery path. Therefore observed GLN values
and delivery preferences cannot establish recipient readiness.

The [announced validation changes](https://www.fortnox.se/developer/blog/new-validation-rules-for-e-invoicing)
take effect on 2026-10-19 and cover references, unit prices, and sender verification.
The preflight warns when both buyer reference fields are empty; it does not claim
to implement all these rules or recipient-specific validation.

## Remaining work for issue #175

Ask Fortnox for a supported interface and access conditions for persisted Peppol
addresses, recipient discovery/status/activation, sender eligibility, and the
effective invoice route. Activation documentation must identify invitation or
notification side effects. Confirm the observed read/write delivery-enum
discrepancy before changing write validation. Then add redacted contract fixtures
and a controlled draft-only readback acceptance test. Until that evidence exists,
issue #175 remains open; this preflight implements its explicit unsupported path.
