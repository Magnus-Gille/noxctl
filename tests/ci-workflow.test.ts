import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const contributing = readFileSync(join(process.cwd(), 'CONTRIBUTING.md'), 'utf8');
const publishing = readFileSync(join(process.cwd(), 'PUBLISHING.md'), 'utf8');

describe('CI workflow', () => {
  it('audits production dependencies only, as a temporary documented exception', () => {
    // TEMPORARY: picomatch <=4.0.7 (dev tooling only) has no fixed release. When it does, restore
    // `npm audit` over the complete graph and revert this test and the two docs.
    expect(workflow).toMatch(/- run: npm audit --omit=dev\r?\n/);
    expect(contributing).toMatch(/production\s+dependencies \(temporarily/);
    expect(publishing).toContain('temporarily enforces `npm audit --omit=dev`');
    expect(publishing).toContain('`npm run check:release`');
    expect(publishing).toContain('production dependency audit');
  });
});
