# Fortnox SIE escape fixtures

These are unmodified voucher blocks extracted from real SIE 4 exports on
2026-09-06 after creating synthetic test vouchers in an owner-authorized Fortnox
demo company. Company headers and unrelated vouchers are excluded.

- `fortnox-terminal-backslash.se`: voucher A2, with stored header and row text
  `Test\`. The export doubles the backslash before the closing quote.
- `fortnox-escape-matrix.se`: voucher A3, with paired debit/credit rows containing
  one/two terminal backslashes, one/two internal backslashes, quotes, and a
  backslash immediately followed by a quote. Expected values are asserted in
  `sie.test.ts` against the text read back from the voucher API.

Both vouchers have zero net effect on account 1930. Only synthetic text, dates,
account numbers, and one-krona amounts are included. No production data is used.
The extracted blocks are ASCII-only, so their bytes are the same in CP437 and
UTF-8; these fixtures do not exercise the separate CP437 decoding path.
