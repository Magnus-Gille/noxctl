# Checkout lockfile reconciliation

## Finding

`package-lock.json` is intentionally part of the source checkout.  A clean
dependency bootstrap is therefore `npm ci`, not a bare `npm install`.

The issue report was reproduced in disposable archives of both current `main`
and historical commit `579ac086` with **Node 22.22.0 / npm 11.8.0**:

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Lockfile unchanged |
| `npm install --ignore-scripts` | Removes the same ten `libc` arrays |

The removed entries are six optional `@rolldown` Linux bindings and four
optional `lightningcss` Linux bindings: ten three-line JSON blocks (30 removed
lines). Both revisions contained those selectors before the command. No
dependency versions, integrity hashes, or package resolutions changed.

This is npm 11.8.0 lockfile serialization during `npm install`, not a change
to noxctl's dependencies or a platform-specific package resolution. The
reported Node 22.22.0 also warns that `lint-staged@17.1.0` needs Node 22.22.1
or newer; that warning is separate from the lockfile behavior.

Use the documented `npm ci` bootstrap for ordinary development, verification,
and CI. Installing the published CLI (`npm install -g noxctl` or `npx noxctl`)
does not need, and must not be run inside, a tracked source checkout. Reserve
`npm install` in a checkout for an intentional dependency change on a branch.

## Safe canonical-checkout reconciliation

After the fix is merged, reconcile a canonical checkout only when its
`package-lock.json` diff is understood and no unrelated work is present. These
commands preserve the accidental diff as a portable patch **before** changing
the checkout:

```bash
git fetch origin
git status --short

# Inspect and preserve the meaningful diff. Stop if other paths are dirty.
git diff --check
git diff -- package-lock.json
git diff --binary -- package-lock.json > ../noxctl-package-lock-before-reconciliation.patch
test -s ../noxctl-package-lock-before-reconciliation.patch

# Only after reviewing the patch, restore this one tracked file to merged main.
git restore --source=origin/main -- package-lock.json
git diff --exit-code origin/main -- package-lock.json
npm ci
git status --short
```

Keep `../noxctl-package-lock-before-reconciliation.patch` with the incident
record until the change has been reviewed. Do not use `reset --hard`, cleanup
commands, or an unreviewed `npm install` as part of this reconciliation.
