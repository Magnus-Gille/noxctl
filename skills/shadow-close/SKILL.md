---
name: shadow-close
description: Run the monthly shadow-ledger reconciliation between Fortnox and the parallel Accounted instance — export SIE from both, diff them, and explain every difference. Use this whenever the user mentions månadsavstämning, skuggkörning, shadow close, "stämmer bokföringen", reconciling the two systems, closing a month, or asks whether Fortnox and Accounted agree. Also use it when a month has just ended and the user asks what needs doing, even if they don't name the systems.
argument-hint: [period, e.g. 2026-09]
---

# Shadow close

Magnus Gille Consulting AB keeps its books in Fortnox while a parallel Accounted
instance on `huginmunin` is being evaluated as a replacement for 2027. Each month
both systems are bookkept independently, then compared. This routine does the
comparison and explains what came out of it.

The comparison is the whole point of the exercise. Two people entering the same
transactions will diverge in interesting ways — a different VAT code, a different
account, a payment matched to the wrong invoice — and those divergences are the
evidence about whether the new system can be trusted with the 2027 books.

## Two rules that matter more than the rest

**Fortnox is authoritative. Always.** If the two disagree, the finding is "the
shadow got it wrong" or "worth investigating" — never "correct Fortnox to match".
Fortnox holds the real books until a decision is made in December; changing them
to settle a disagreement destroys the thing being measured and touches live
accounting records.

**Never copy vouchers between the systems.** If entries are mirrored rather than
entered independently, the diff only proves the copying worked. Book each system
from the source documents.

## Steps

### 1. Establish the period and check access

Confirm which month is being closed before touching anything — an accidental
reconciliation of the wrong period wastes the comparison. If the user gave no
period, the previous calendar month is the sensible default, but say which one is
assumed.

On macOS the Fortnox credentials sit behind a hardware key:

```bash
noxctl keychain unlock     # prompts for a YubiKey tap
noxctl company info        # confirms the connection works
```

### 2. Export SIE from Fortnox

```bash
mkdir -p ~/skugga
noxctl sie export --file ~/skugga/fortnox-<YYYY-MM>.se
```

Type 4 is the default and the right one: it carries balances *and* every voucher,
which is what makes voucher-count differences visible.

### 3. Export SIE from Accounted

Either from the UI (Rapporter → SIE-export) or over its API:

```bash
curl -sS -H "Authorization: Bearer $ACCOUNTED_API_KEY" \
  "$ACCOUNTED_URL/api/v1/companies/$ACCOUNTED_COMPANY_ID/reports/sie-export" \
  -o ~/skugga/accounted-<YYYY-MM>.se
```

Write the bytes unchanged. SIE is CP437-encoded by spec, and re-encoding it to
UTF-8 corrupts the Swedish characters in account names.

### 4. Diff

```bash
noxctl -o table sie diff ~/skugga/accounted-<YYYY-MM>.se \
                --against ~/skugga/fortnox-<YYYY-MM>.se
```

Left is Fortnox, right is the shadow, so a positive delta means Fortnox carries
more on that account.

`-o table` matters here: output defaults to JSON whenever stdout is piped, and
the table is far easier to reason about when reporting back to a human.

### 5. Explain every difference

A list of deltas is not the deliverable — an explanation is. Work each row until
its cause is known, reading the underlying vouchers in both systems where needed.
Common causes:

| Symptom | Usually means |
|---|---|
| One VAT account differs | Different VAT code on an article or invoice row, or different rounding |
| Account appears on one side only | Posted to a different account in the other system |
| Voucher counts differ | Something is unbooked, or the systems group payments differently |
| Everything differs by the same amount | Opening balances disagree — check the SIE import |
| `OBALANS` reported | A voucher does not sum to zero. Serious; investigate before anything else |

Voucher *count* differences are often benign: the two systems legitimately group
payments differently. Differences in **UB and RES** are the ones that matter,
because those are what a balance sheet and an income statement are built from.

Note also what the diff cannot see. It compares balances, not classification
inside an account, and not whether either system is right about Swedish rules —
two ledgers can agree perfectly and both be wrong.

### 6. Record the outcome

Append to `~/skugga/logg.md`: the period, whether it was clean, each difference
with its cause, and how long the shadow bookkeeping took compared with Fortnox.

The time comparison is easy to skip and genuinely useful. The December decision
is partly "is this pleasant enough to live in", and by then the memory of
September will be gone.

Then update the checklist in `docs/shadow-run.md` if this month answered one of
its open questions — particularly anything about payroll, AGI, VAT, or iXBRL.

## Reporting back

Lead with the verdict, then the differences, then what it means for the decision:

```
Avstämning 2026-09: 2 avvikelser, båda förklarade.

  2610 Utgående moms   −2 812,50   Skuggan bokade 25 % på en rad som ska vara 6 %
  2640 Ingående moms     −812,50   Kvitto bokfört i skuggan men inte i Fortnox

Verifikat: Fortnox 7 / skugga 8 (skuggan delar upp löneutbetalningen)
Tidsåtgång: ~25 min i skuggan mot ~10 min i Fortnox.

Öppen fråga: momskoder sätts inte automatiskt per artikel i skuggan.
```

If everything matched, say so plainly and keep it short — a clean month needs no
essay. But still log the time, since that is the part a clean month still teaches.
