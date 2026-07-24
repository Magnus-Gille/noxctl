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

    expect(runbook).toContain('git diff --binary -- package-lock.json >');
    expect(runbook).toContain('git restore --source=HEAD -- package-lock.json');
    expect(runbook).toContain('git merge --ff-only origin/main');
    expect(runbook).not.toContain('git restore --source=origin/main -- package-lock.json');
    expect(runbook).toContain('npm ci');
    expect(runbook).toContain('Node 22.22.0 / npm 11.8.0');
  });
});
