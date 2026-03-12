# Status

Last updated: 2026-03-12

## Branch

- `main`
- HEAD: `b74ed58` style: format TypeScript files for CI

## Completed This Session

- Deep security/privacy hardening committed and pushed:
  - `860257d` `fix: harden security and privacy defaults`
  - `b74ed58` `style: format TypeScript files for CI`
- Fixed CI failure caused by Prettier drift after the hardening commit
- Refreshed `README.md` to match the current repo/package reality:
  - project/package name is `noxctl`
  - clone URL is `https://github.com/Magnus-Gille/noxctl.git`
  - quick start now distinguishes npm vs source installs
  - setup/Claude registration examples now use commands that actually work
  - Linux `secret-tool` requirement is documented
  - mutation-safety examples reflect current CLI flags
  - development section notes the current ESLint 10 config gap

## Verification

- `npm run build`
- `npm test` -> 131 tests passing
- `npm run format:check`
- CI rerun triggered after pushing `b74ed58`

## Current Repo State

- README is aligned with current code and packaging
- Security/privacy hardening is on `main`
- Remaining repo issue: `npm run lint` still fails until `eslint.config.js` is added

## Next Steps

- Confirm GitHub Actions succeeds for `b74ed58`
- Fix ESLint 10 config (`eslint.config.js`)
- Decide how strictly Linux setup should require `secret-tool`
