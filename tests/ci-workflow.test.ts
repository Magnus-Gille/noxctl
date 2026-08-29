import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const contributing = readFileSync(join(process.cwd(), 'CONTRIBUTING.md'), 'utf8');
const publishing = readFileSync(join(process.cwd(), 'PUBLISHING.md'), 'utf8');

describe('CI workflow', () => {
  it('audits the complete installed dependency graph', () => {
    expect(workflow).toContain('- run: npm audit\n');
    expect(workflow).not.toContain('npm audit --omit=dev');
    expect(contributing).toMatch(/complete installed\s+dependency graph/);
    expect(publishing).toContain(
      'CI enforces `npm audit` across production and development dependencies',
    );
    expect(publishing).toContain('`npm run check:release`');
    expect(publishing).toContain('production dependency audit');
  });
});
