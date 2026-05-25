# Project Status

**Last session:** 2026-05-25
**Branch:** main (feature work uncommitted)

## Completed This Session

- **YubiKey-locked dedicated keychain (macOS) — feature complete, pending live verification + commit**
  - `src/keychain-target.ts`: full module — challenge-response (`computeChallengeResponse`, OTP slot 2), dedicated-keychain create/unlock/lock/lock-state, prompt-free locked-read (`readDedicatedSecret` → `KeychainLockedError`, no GUI dialog), challenge file read/write, `activeKeychainPath()` precedence (env override → darwin files-exist → null), `deleteLoginSecret`/`loginKeychainPath` for seal.
  - `src/credentials-store.ts`: reads/writes/deletes route to the dedicated keychain when active (Swift via stdin, path passed as argv).
  - `src/auth.ts`: `loadCredentials` now re-throws `KeychainLockedError` (was swallowed) so a locked keychain surfaces instead of looking like "no creds".
  - `src/cli.ts`: new `noxctl keychain` group — `init` (copy-and-keep migration), `unlock`, `lock`, `status`, `seal`; `doctor` reports dedicated-mode + lock state + ykman.
  - Tests: new `tests/keychain-target.test.ts` (39 tests). Full suite 499 pass, lint clean.
  - Swift plumbing validated end-to-end with a static password (no YubiKey) — 9/9 checks.

## In Progress

- **Live verification still needed (requires the user + a physical tap):** `noxctl keychain init` then `unlock` on the Mac. CI has no hardware. Then commit.

## Blockers

None.

## Next Steps

- User runs `noxctl keychain init` / `unlock` to verify the tap flow, then commit the feature.
- Consider a CHANGELOG entry + version bump when releasing.
- See `TODO.md` for the rest of the backlog.
