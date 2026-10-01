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

  it('treats every unexpected fetch exit as an error before the schema audit', () => {
    expect(workflow).toContain('elif [ "$EXIT_CODE" -ne 0 ]; then');
    expect(workflow).not.toContain('elif [ "$EXIT_CODE" -eq 2 ]; then');
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
    expect(workflow).toContain('group: api-drift-check');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('github.paginate(github.rest.issues.listForRepo');
    expect(workflow).toContain('github.rest.issues.createComment');
    expect(workflow).toContain('github.rest.issues.create({');
  });

  it('never writes to the repository, so a protected main cannot block reporting', () => {
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n {2}issues: write\n/);
    expect(workflow).not.toContain('contents: write');
    expect(workflow).not.toContain('git push');
    expect(workflow).not.toContain('git commit');
    expect(workflow).not.toContain('git add');
  });

  it('deduplicates spec-drift issues, because drift repeats until the fingerprint is refreshed', () => {
    const start = workflow.indexOf('- name: Open issue on API change');
    const end = workflow.indexOf('- name: Open issue on fetch error');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step = workflow.slice(start, end);

    expect(step).toContain('github.paginate(github.rest.issues.listForRepo');
    expect(step).toContain("i.title.startsWith('Fortnox API spec changed')");
    expect(step).toContain('github.rest.issues.createComment');
    expect(step).toContain('github.rest.issues.create({');
    expect(step).toContain('npm run check:api');
    expect(step).not.toContain('fingerprint committed');
  });

  it('reports drift before the implementation coverage check can fail the job', () => {
    const coverageIndex = workflow.indexOf('- name: Check implementation coverage');
    const reportSteps = [
      '- name: Open issue on API change',
      '- name: Open issue on fetch error',
      '- name: Report MCP write-schema audit',
    ];

    expect(coverageIndex).toBeGreaterThan(-1);
    for (const name of reportSteps) {
      const index = workflow.indexOf(name);
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeLessThan(coverageIndex);
    }
  });
});
