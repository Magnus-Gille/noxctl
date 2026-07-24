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
the checkout. Run the block as a whole in Bash or Zsh: its strict-mode
subshell stops at the first failed safety check without changing the caller's
shell options.

```bash
(
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
git fetch origin
git status --short

# Refuse mechanically unless package-lock.json is the one and only dirty path.
dirty_count="$(git status --porcelain=v1 --untracked-files=all | wc -l | tr -d '[:space:]')"
lockfile_dirty_count="$(git status --porcelain=v1 --untracked-files=all -- package-lock.json | wc -l | tr -d '[:space:]')"
dirty_path="$(git status --porcelain=v1 --untracked-files=all | cut -c4-)"
test "$dirty_count" -eq 1
test "$lockfile_dirty_count" -eq 1
test "$dirty_path" = package-lock.json

# Inspect and preserve the complete meaningful diff against HEAD, including
# changes that may already have been staged.
git diff HEAD --check -- package-lock.json
git diff HEAD -- package-lock.json
git diff --binary HEAD -- package-lock.json > ../noxctl-package-lock-before-reconciliation.patch
test -s ../noxctl-package-lock-before-reconciliation.patch

# Only after reviewing the patch, restore the accidental rewrite against the
# checkout's own revision and prove the whole working tree is clean.
git restore --source=HEAD --staged --worktree -- package-lock.json
git diff HEAD --exit-code
test -z "$(git status --porcelain=v1 --untracked-files=all)"

# Now advance the complete canonical checkout atomically to reviewed main.
# Never combine a new lockfile with an old package.json.
git merge --ff-only origin/main
npm ci
git diff HEAD --exit-code
test -z "$(git status --porcelain=v1 --untracked-files=all)"
)
```

Keep `../noxctl-package-lock-before-reconciliation.patch` with the incident
record until the change has been reviewed. Do not use `reset --hard`, cleanup
commands, a partial source-file update, or an unreviewed `npm install` as part
of this reconciliation.
