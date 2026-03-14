# Privacy Notes

## Scope

This project is a local CLI/MCP client for the Fortnox API. It does not operate a hosted backend of its own, but it can still move accounting and personal data into other systems depending on how you use it.

## What Data May Be Exposed

Fortnox responses can contain:

- customer and supplier names
- email addresses, phone numbers, and addresses
- organisation numbers or VAT numbers
- invoice text, voucher text, and bookkeeping metadata
- company information and settings

The summarized default output reduces exposure, but it does not eliminate it.

## `includeRaw`

`includeRaw: true` appends the full Fortnox JSON payload to tool output.

That is useful for debugging, but it increases the chance that sensitive accounting or personal data will be copied into:

- AI chat transcripts
- MCP client logs
- shell history or terminal captures
- screenshots or shared debugging notes

Use it only when you need fields that are missing from the summarized output.

## AI And MCP Use

If you run noxctl through Claude, an MCP host, or another AI product, data shown to the model may be processed by that provider under its own terms.

Before using real accounting data with AI tooling, verify:

- whether the provider acts as a processor or subprocessor in your setup
- whether retention and logging are acceptable
- whether cross-border transfers need assessment
- whether your internal policies allow this use

## Project Position

- noxctl is an unofficial open-source client
- it does not claim to solve GDPR compliance for you
- it does not claim to make Swedish tax filings or bookkeeping legally correct by itself

You remain responsible for deciding what data to send through the tool and what systems may receive it.
