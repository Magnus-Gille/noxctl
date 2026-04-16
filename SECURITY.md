# Security Policy

## Reporting a vulnerability

If you think you have found a security issue in noxctl, please report it privately
so it can be investigated and fixed before public disclosure.

- **Preferred:** open a [private security advisory](https://github.com/Magnus-Gille/fortnox-mcp/security/advisories/new) on GitHub.
- **Email:** `magnus.gille@outlook.com` with the subject `noxctl security`.

Please include:

- a description of the issue and its impact
- steps to reproduce, or a minimal proof of concept
- the noxctl version (`noxctl --version`) and platform
- any suggested mitigation if you have one

You will get an acknowledgement within a few business days. If the report is
confirmed, a fix will be prepared on a private branch, a patched release cut,
and a GitHub advisory published with credit (if you want it).

Please do not open a public issue, pull request, or post to social media before
a patched release is available.

## Scope

This policy covers the code in this repository — the `noxctl` CLI and MCP
server. It does not cover:

- the Fortnox platform itself (report to Fortnox directly)
- third-party Claude, MCP host, or AI tooling (report upstream)
- issues in OS keychain implementations (`security`, `secret-tool`, DPAPI)

## What counts as a vulnerability

In scope:

- credential or token leakage through logs, errors, tool responses, or the keychain store
- auth-flow issues in `noxctl init` (OAuth state handling, loopback binding, code exchange)
- command injection, path traversal, or unsafe JSON/stdin handling in the CLI
- ways to bypass mutation confirmation, `dryRun`, or `includeRaw` guardrails
- dependency vulnerabilities reachable through normal use

Out of scope (not security issues by themselves):

- missing features or API endpoints
- Fortnox returning an error, rate-limiting a user, or changing its API
- reports that require physical or local OS account access
- self-XSS in your own terminal

## Security expectations for users

- Keep noxctl and your Node.js version up to date
- Never commit your Fortnox `Client ID` / `Client Secret` or the `~/.cli-m365-*` or
  keychain backing files
- Treat MCP tool output as potentially containing customer or supplier personal
  data — see [PRIVACY.md](PRIVACY.md) and the Privacy section of the README
- Keep `includeRaw` off unless you need it; raw payloads can expose more
  accounting and personal data to AI transcripts and logs
