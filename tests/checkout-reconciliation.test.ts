import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('checkout reconciliation guidance', () => {
  it('uses npm ci as the documented development bootstrap', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toContain('## Development\n\n```bash\nnpm ci');
    expect(readme).not.toContain('## Development\n\n```bash\nnpm install');
  });

  it('documents how to preserve a lockfile diff before reconciliation', () => {
    const runbook = readFileSync('docs/checkout-reconciliation.md', 'utf8');

    expect(runbook).not.toContain('git restore --source=origin/main -- package-lock.json');
    expect(runbook).toContain('Node 22.22.0 / npm 11.8.0');

    const safetyCriticalSequence = [
      'set -euo pipefail',
      'dirty_count="$(git status --porcelain=v1 --untracked-files=all | wc -l | tr -d',
      'lockfile_dirty_count="$(git status --porcelain=v1 --untracked-files=all -- package-lock.json | wc -l | tr -d',
      'dirty_path="$(git status --porcelain=v1 --untracked-files=all | cut -c4-)"',
      'test "$dirty_count" -eq 1',
      'test "$lockfile_dirty_count" -eq 1',
      'test "$dirty_path" = package-lock.json',
      'git diff --binary -- package-lock.json >',
      'test -s ../noxctl-package-lock-before-reconciliation.patch',
      'git restore --source=HEAD -- package-lock.json',
      'git diff --exit-code',
      'test -z "$(git status --porcelain=v1 --untracked-files=all)"',
      'git merge --ff-only origin/main',
      'npm ci',
      'git diff --exit-code',
      'test -z "$(git status --porcelain=v1 --untracked-files=all)"',
    ];

    let previousIndex = -1;
    for (const command of safetyCriticalSequence) {
      const commandIndex = runbook.indexOf(command, previousIndex + 1);
      expect(commandIndex, `${command} must follow the preceding safety step`).toBeGreaterThan(
        previousIndex,
      );
      previousIndex = commandIndex;
    }
  });
});
