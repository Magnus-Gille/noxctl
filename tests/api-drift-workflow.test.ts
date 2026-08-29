import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/api-drift.yml'), 'utf8');

describe('weekly API drift workflow', () => {
  it('runs the write-schema audit after a successful spec fetch with pinned Node 22', () => {
    const fetchIndex = workflow.indexOf('- name: Check for API changes');
    const auditIndex = workflow.indexOf('- name: Check MCP write-schema coverage');

    expect(workflow).toContain(
      'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0',
    );
    expect(workflow).toContain('node-version: 22');
    expect(workflow).toContain('npm ci --ignore-scripts --no-audit');
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(fetchIndex);
    expect(workflow).toContain("if: steps.diff.outputs.error != 'true'");
  });

  it('uses only the privacy-safe audit mode and never persists the fetched spec', () => {
    expect(workflow).toContain('npm run audit:schemas --silent');
    expect(workflow).not.toContain('audit:schemas -- --update');
    expect(workflow).not.toContain('--show-fields');
    expect(workflow).not.toContain('actions/upload-artifact');
    expect(workflow).not.toMatch(/git add[^\n]*openapi\.json/);
  });

  it('maps drift and errors to deduplicated issue updates', () => {
    expect(workflow).toContain('id: schema_audit');
    expect(workflow).toContain('echo "changed=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('echo "error=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("steps.schema_audit.outputs.changed == 'true'");
    expect(workflow).toContain("steps.schema_audit.outputs.error == 'true'");
    expect(workflow).toContain('MCP write schema drift');
    expect(workflow).toContain('MCP write schema audit failed');
    expect(workflow).toContain('github.rest.issues.listForRepo');
    expect(workflow).toContain('github.rest.issues.createComment');
    expect(workflow).toContain('github.rest.issues.create({');
  });
});
