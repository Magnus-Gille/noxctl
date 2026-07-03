# Legacy credential reader removal plan

## Background

`noxctl` 0.2.0 introduced per-profile credential storage: instead of a single
unnamespaced keychain/DPAPI entry, credentials are stored under a
`profile:<name>` account (or `credentials.<name>.dpapi` file on Windows), with
`default` as the implicit profile for single-tenant setups.

To avoid breaking installs still on the pre-0.2.0 layout, `noxctl` shipped two
compatibility mechanisms in `src/credentials-store.ts`:

- **Dual-write** — on every credential save for the `default` profile, also
  mirror the blob to the legacy unnamespaced slot, so a not-yet-upgraded 0.1.x
  binary could keep reading credentials written by a newer version.
- **Legacy read fallback** — `loadCredentialBlob` falls back to the legacy
  slot (and, before that, a legacy plaintext `credentials.json` file) when the
  namespaced slot is empty, so upgrading to 0.2.0+ doesn't strand a user's
  existing session.

Dual-write was scoped to "the 0.2.x compatibility window" and self-labeled
`REMOVE IN 0.3.0`. That didn't happen in 0.3.0; as of 0.4.0 the flag was still
`true`. It was flipped to `false` in #53 (this repo, 2026-07-03) — the
compatibility window has clearly passed, and disabling the write side carries
no migration risk since it's purely additive (removing it means one less
keychain write, not a behavior newer clients depend on).

## What's staying for now: the legacy reader

The **read** fallback in `loadCredentialBlob` (the `legacy` / `both-*-preferred`
/ `legacy-plaintext` source branches) is intentionally **not** being removed
yet. Unlike the write side, removing the reader is a breaking change: any
external `noxctl` npm install that

- installed before 0.2.0,
- has not run `noxctl init` or otherwise re-authenticated since (so no
  namespaced `profile:default` entry was ever written), and
- upgrades straight to a version without the legacy reader

would suddenly find `noxctl` unable to locate its stored credentials, with no
error pointing at the cause — it would look like a fresh, unauthenticated
install.

## Removal plan

- **Target release: 0.5.0.** Per semver, dropping read support for the 0.1.x
  credential layout is a breaking change and gets a minor bump (this project
  is pre-1.0, so breaking changes are signaled via the minor version).
- **Migration note in the 0.5.0 changelog entry:** users upgrading from a
  version prior to 0.2.0 (or who have not re-authenticated since 0.2.0 shipped)
  must run `noxctl init` (or otherwise trigger a credential save) on 0.4.x
  *before* upgrading to 0.5.0, so their credentials are migrated to the
  namespaced slot while the legacy reader is still present to seed it.
- **Removal scope:** delete the `legacy` / `both-new-preferred` /
  `both-legacy-preferred` / `legacy-plaintext` branches in
  `loadCredentialBlob`, `loadLegacyPlaintextSecret`, `removeLegacyPlaintextSecret`,
  and the now-fully-dead `LEGACY_DUAL_WRITE` write path in
  `saveCredentialBlob` (already inert since #53, but the flag and branch can be
  deleted outright once the reader goes).
- **Pre-removal check:** before cutting 0.5.0, confirm via the existing test
  suite (`tests/credentials-store.test.ts`) that no code path outside
  `credentials-store.ts` depends on the `legacy*` / `both-*` `LoadSource`
  variants, and update `LoadSource`'s type accordingly.
