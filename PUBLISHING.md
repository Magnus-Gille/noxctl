# Publishing Checklist

Use this checklist before publishing a release, pushing broad visibility changes, or announcing the project publicly.

## Scope

Decide what you are publishing:

- public GitHub only
- npm package
- broader distribution or commercial use

If the scope changes, re-check the Fortnox terms and the privacy wording before release.

## Repo Hygiene

- No tracked local state files such as `STATUS.md`, `PLAN.md`, or other session notes
- No live customer, supplier, invoice, or company data in docs, tests, examples, or commits
- No credentials, tokens, or tenant-specific config in tracked files
- `.gitignore` still excludes local/private operational files
- Examples and test fixtures use synthetic data only

## Privacy And AI

- `README.md` and `PRIVACY.md` still describe AI/MCP data exposure accurately
- `includeRaw` remains opt-in and clearly marked as higher-risk
- No new examples encourage sending real accounting data to AI tooling unnecessarily
- Any new tools that return broad payloads are documented with privacy implications

## Tax And Bookkeeping Claims

- No README, tool description, or help text implies legal/tax correctness by itself
- VAT reporting language stays informational unless the implementation materially improves
- Any bookkeeping automation still requires explicit confirmation or dry-run support
- User-facing wording continues to tell users to reconcile against Fortnox and their records

## Fortnox Positioning

- Project still states it is unofficial and not affiliated with Fortnox
- Setup docs still require the user's own Fortnox account and app credentials
- No wording implies Fortnox marketplace approval or certification unless that has actually happened
- If Fortnox terms or publication requirements changed, docs are updated before release

## Release Checks

- `npm test`
- `npm run lint`
- `npm run build`
- Review `git diff --stat origin/main..HEAD`
- Sanity-read `README.md`, `PRIVACY.md`, and the tax tool descriptions

## History Safety

- If sensitive data was ever committed, confirm whether a history rewrite is needed before release
- Do not assume a normal delete commit is sufficient for previously published secrets or private business data

## Decision Gate

Publish only if all of the following are true:

- the repo contains no live business data
- the public docs match the actual privacy and tax risk level
- Fortnox-facing claims are conservative and accurate
- the release target has been chosen deliberately
