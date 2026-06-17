# Project Status

**Last session:** 2026-06-17
**Branch:** `feat/payroll-salary-integration` — pushed, **PR #49 open** (awaiting review/merge); `main` is **0.3.0 shipped**

## Unreleased — Payroll (Lön) integration ⏳ (branch `feat/payroll-salary-integration`, commit `bfe84c4`)

Full coverage of the Fortnox salary API — the endpoints were in the spec all along; the unlock was Fortnox now exposing the **Lön** Behörighet to integrations.

- **employees** (list/get/create/update), **salary-transactions**, **attendance-transactions** (närvaro), **absence-transactions** (frånvaro) [each list/get/create/delete], **schedule-times** (get/update/reset-day — composite EmployeeId+Date key). Operations + MCP tools (Swedish) + CLI + views + tests for each.
- **`salary` scope is OPT-IN** (not in default `SCOPES` — would break `init` for apps lacking the Lön permission). Enable via `noxctl init --with-salary` (or `FORTNOX_WITH_SALARY=1`). Granted scopes persisted per-profile (`FortnoxCredentials.scopes`); client-credentials refresh + `doctor`/`fortnox_status` honor it via `effectiveScopes(creds)`. Existing installs unaffected until they re-init with the flag.
- Adversarial review caught 1 bug (attendance list dropped the employeeid/date filter on the `all` branch) — fixed red/green.
- **678 unit tests**, lint + format + build green.

### Payroll — live-verified on demo (2026-06-17) ✅
Re-authed demo with `--with-salary`, then ran the full round-trip against the real Fortnox API:
- ✅ `salary` scope authorized (`doctor`: 12/12).
- ✅ **employees** create / get / update — create needs **EmploymentForm + PersonelType + SalaryForm** so Fortnox can assign a company agreement (otherwise the cryptic 400 `ftgavtalid`). Not a missing API field, not a demo-config gap.
- ✅ **attendance** + **absence** create → get → delete (clean round-trips).
- ✅ **schedule-times** get + update (Hours 0→8).
- ⚠️ **salary-transactions** reaches the API & validates correctly, but needs a valid löneart for the active agreement (no list-lönearter endpoint exists to discover codes). Path proven; not a code bug.
- Ergonomics added (commit `47d78d6`): `employees create` flags for the agreement fields + a targeted hint on the ftgavtalid error. Test employee left inactivated on demo (Employee API has no hard DELETE).
- **678 unit tests**, lint + format + build green.

### Payroll — PR #49 open
- Merge PR #49, then cut a release (include the opt-in `salary` scope re-init note in the release notes, like #37's inbox/connectfile).
- Optional: find a valid löneart on a configured Lön company to prove a green salary-transaction create.

## 0.3.0 — SHIPPED ✅

- Published to **npm** (`noxctl@0.3.0`, latest) + public **GitHub release v0.3.0**.
- Features: voucher file attachments (#37), Contracts API (#10), financial years / locked period (#11), analytics views + `dashboard` (#7/#12), natural date periods (#9), shell completions (#8), confirmation payload preview (#6), YubiKey serial diagnostics (#33), customer read-only field stripping (#31). **BREAKING (#34):** single-resource JSON output wrapped under the singular resource key.
- Earlier PR #35 went through 5 Codex review rounds + 9 fixes; PR #38 added #37.

## Live verification (demo company)

#37 was live-verified against the Fortnox demo company (**MagnusGilleConsultingDEMO**, tenant 1818238) — which caught **3 bugs every mock test passed** (PR #45):

1. noxctl never requested the `inbox` / `connectfile` OAuth scopes → added to `SCOPES` (+ `doctor`/`status` now test them and detect the 400 scope-error form).
2. `VoucherYear` is read-only on the voucherfileconnections POST → moved to the `?financialyear=` query param.
3. `/3/financialyears` rejects a `?Date=` filter (error 2000588) → date→FY resolution now filters locally.

CHANGELOG corrected (PR #46); `v0.3.0` tag re-pointed to include all fixes.

## Setup added

- Reusable **`demo` profile** → MagnusGilleConsultingDEMO, authorized via the `noxctl` app with `inbox`+`connectfile` scopes. Use `--profile demo` for live write-testing. (Sandbox test data left there: voucher A/1 + a few inbox files — ignorable.)
- **api-drift check restored** (#39, PR #42): extracts the spec from the ReDoc docs page (openapi.json endpoint is hard-429'd). Verified green in CI.

## Open Issues

- **#13** — bank transactions only (attachments half shipped via #37). The refreshed spec exposes `/3/noxfinansinvoices` (Fortnox Finans) — worth checking whether it covers part of this.

## Next Steps

- (Optional) re-auth the `default` (real-company) profile with `inbox`+`connectfile` if you want attachments there too; live-verify the other new endpoints against real data.
- `LEGACY_DUAL_WRITE` ("REMOVE IN 0.3.0"): recommend removing the legacy *reader* in 0.4.0 (avoids stranding 0.1.x→0.3.0 direct upgraders).
- Investigate `/3/noxfinansinvoices` for #13.

## Notes

- 677 unit tests, lint + build green.
- Lesson reinforced: mock tests can't validate Fortnox scope / read-only / query-param semantics — **live-verify write features against the demo company before publishing.**
