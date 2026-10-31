import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/api-drift.yml'), 'utf8');
const workflowLines = workflow.split(/\r?\n/);

const CHECK_JOB = 'check-api-spec';
const REPORT_JOB = 'report-tickets';

/** The lines of one step, from its `- name:` line to the next step, step-level comment or job. */
function stepBlock(name: string): string[] {
  const start = workflowLines.indexOf(`      - name: ${name}`);
  if (start === -1) throw new Error(`Step not found: ${name}`);
  const rest = workflowLines.slice(start + 1);
  const end = rest.findIndex((line) => /^( {0,4}\S| {6}(- |# ))/.test(line));
  return [workflowLines[start], ...(end === -1 ? rest : rest.slice(0, end))];
}

/** One job's text, without comments, from its header to the next job. */
function jobText(name: string): string {
  const start = workflowLines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`Job not found: ${name}`);
  const rest = workflowLines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[A-Za-z][\w-]*:/.test(line));
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function stepCondition(name: string): string {
  const line = stepBlock(name).find((l) => l.startsWith('        if: '));
  if (!line) throw new Error(`Step has no condition: ${name}`);
  return line.slice('        if: '.length);
}

/** The command of a one-line `run:` step. */
function stepRun(name: string): string {
  const line = stepBlock(name).find((l) => l.startsWith('        run: '));
  if (!line) throw new Error(`Step has no single-line run: ${name}`);
  return line.slice('        run: '.length);
}

const GATEWAY_SECRET_ENV = [
  '          TICKET_GATEWAY_URL: ${{ secrets.TICKET_GATEWAY_URL }}',
  '          TICKET_GATEWAY_TOKEN: ${{ secrets.TICKET_GATEWAY_TOKEN }}',
];

const PREFLIGHT = 'Verify ticket gateway access';
const REPORTS = {
  'File ticket on API change': 'file drift',
  'File ticket on fetch error': 'file fetch-error',
  'Report MCP write-schema audit': 'file schema',
};
const TICKET_STEPS = [PREFLIGHT, ...Object.keys(REPORTS)];

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

  it('serialises runs and maps each outcome to an output of the check job', () => {
    expect(workflow).toContain('id: schema_audit');
    expect(workflow).toContain('echo "changed=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('echo "error=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('group: api-drift-check');
    expect(workflow).toContain('cancel-in-progress: false');

    const outputs = {
      diff_changed: 'steps.diff.outputs.changed',
      diff_error: 'steps.diff.outputs.error',
      diff_summary: 'steps.diff.outputs.summary',
      schema_changed: 'steps.schema_audit.outputs.changed',
      schema_error: 'steps.schema_audit.outputs.error',
      schema_summary: 'steps.schema_audit.outputs.summary',
    };
    for (const [name, source] of Object.entries(outputs)) {
      expect(jobText(CHECK_JOB)).toContain(`      ${name}: \${{ ${source} }}`);
    }
  });

  it('never writes to the repository, so a protected main cannot block reporting', () => {
    expect(workflow).not.toContain('contents: write');
    expect(workflow).not.toContain('git push');
    expect(workflow).not.toContain('git commit');
    expect(workflow).not.toContain('git add');
  });

  it('still fails the check job when implementation coverage fails, after the audits', () => {
    expect(stepCondition('Check implementation coverage')).toBe(
      "${{ !cancelled() && steps.diff.outputs.error != 'true' && steps.schema_audit.outputs.error != 'true' }}",
    );
    expect(workflow.indexOf('- name: Check implementation coverage')).toBeGreaterThan(
      workflow.indexOf('- name: Check MCP write-schema coverage'),
    );
  });
});

describe('ticket filing in the weekly API drift workflow', () => {
  it('files tickets through the script instead of opening GitHub issues', () => {
    for (const [name, args] of Object.entries(REPORTS)) {
      expect(stepRun(name)).toBe(`node scripts/file-plane-ticket.mjs ${args}`);
    }
    expect(workflow).not.toContain('actions/github-script');
    expect(workflow).not.toContain('github.rest.issues');
    expect(workflow).not.toContain('github.paginate');
  });

  it('needs no GitHub permission beyond reading the repository', () => {
    expect(workflow).toMatch(/permissions:\r?\n {2}contents: read\r?\n\r?\njobs:/);
    expect(workflow).not.toContain('issues: write');
    expect(workflow).not.toMatch(/^ *(issues|pull-requests|actions|id-token|statuses):/m);
  });

  it('files every report from the check results, even when the check job failed', () => {
    const job = jobText(REPORT_JOB);
    expect(job).toContain(`    needs: ${CHECK_JOB}`);
    // Without !cancelled() a failed check job (for example the coverage check) skips this job.
    expect(job).toContain('    if: ${{ !cancelled() }}');

    const conditions = {
      'File ticket on API change': `needs.${CHECK_JOB}.outputs.diff_changed == 'true'`,
      'File ticket on fetch error': `needs.${CHECK_JOB}.outputs.diff_error == 'true'`,
      'Report MCP write-schema audit': `(needs.${CHECK_JOB}.outputs.schema_changed == 'true' || needs.${CHECK_JOB}.outputs.schema_error == 'true')`,
    };
    // !cancelled() so one failed report cannot skip the others.
    for (const [name, predicate] of Object.entries(conditions)) {
      expect(stepCondition(name)).toBe(`\${{ !cancelled() && ${predicate} }}`);
    }
  });

  it('hands the reports to the script as data in environment variables', () => {
    const inputs = {
      'File ticket on API change': ['DIFF_SUMMARY: diff_summary'],
      'File ticket on fetch error': ['DIFF_SUMMARY: diff_summary'],
      'Report MCP write-schema audit': [
        'SCHEMA_AUDIT_SUMMARY: schema_summary',
        'SCHEMA_AUDIT_CHANGED: schema_changed',
        'SCHEMA_AUDIT_ERROR: schema_error',
      ],
    };
    for (const [name, pairs] of Object.entries(inputs)) {
      for (const pair of pairs) {
        const [variable, output] = pair.split(': ');
        expect(stepBlock(name)).toContain(
          `          ${variable}: \${{ needs.${CHECK_JOB}.outputs.${output} }}`,
        );
      }
    }
    expect(workflow).not.toMatch(/run:.*needs\./);
  });

  it('checks the gateway first in the report job, whatever the weekly checks found', () => {
    expect(stepRun(PREFLIGHT)).toBe('node scripts/file-plane-ticket.mjs check');
    expect(stepBlock(PREFLIGHT).some((l) => l.startsWith('        if: '))).toBe(false);

    const reportJob = workflowLines.indexOf(`  ${REPORT_JOB}:`);
    const names = workflowLines
      .slice(reportJob)
      .filter((l) => /^ {6}- (name|uses): /.test(l))
      .map((l) => l.replace(/^ {6}- (name|uses): /, ''));
    expect(names[0]).toMatch(/^actions\/checkout@/);
    expect(names[1]).toMatch(/^actions\/setup-node@/);
    expect(names[2]).toBe(PREFLIGHT);
  });

  it('keeps the secrets in one job that runs nothing but the filing script', () => {
    // Everything that runs npm and repository code (the spec fetch, npm ci, the audits) is in
    // the check job, which holds no secret; code that ran there cannot reach the report job.
    expect(jobText(CHECK_JOB)).not.toMatch(/secrets|environment/);

    const report = jobText(REPORT_JOB);
    const runs = [...report.matchAll(/^ {8}run: (.*)$/gm)].map((m) => m[1]);
    expect(runs).toHaveLength(TICKET_STEPS.length);
    for (const run of runs)
      expect(run).toMatch(/^node scripts\/file-plane-ticket\.mjs (check|file )/);
    expect(report).not.toMatch(/\bnpm\b|\bnpx\b|run: \|/);
    expect(report).toContain('persist-credentials: false');
    expect(report).not.toContain('cache:');
  });

  it('hands the secrets to exactly the steps that talk to the gateway, as environment only', () => {
    const secretLines = workflowLines.filter((line) => line.includes('${{ secrets.'));
    expect(secretLines).toHaveLength(TICKET_STEPS.length * GATEWAY_SECRET_ENV.length);

    for (const name of TICKET_STEPS) {
      const block = stepBlock(name);
      expect(block).toContain('        env:');
      for (const line of GATEWAY_SECRET_ENV) expect(block).toContain(line);
    }
    // Not at workflow, job or step-list level, and never wholesale.
    expect(workflow).not.toMatch(/^env:/m);
    expect(workflow).not.toMatch(/^ {4}env:/m);
    expect(workflow).not.toMatch(/^ {6}env:/m);
    expect(workflow).not.toContain('secrets: inherit');
    expect(workflow).not.toContain('toJSON(secrets)');
    expect(workflow).not.toMatch(/secrets\[/);
  });

  it('never puts a secret or any expression on a command line', () => {
    for (const name of TICKET_STEPS) {
      expect(stepRun(name)).not.toContain('${{');
      expect(stepRun(name)).not.toMatch(/\b(echo|printenv|env|curl|set -x)\b/);
    }
    expect(workflow).not.toMatch(/--header|-H "Authorization|TICKET_GATEWAY_TOKEN=/);
    expect(workflow).not.toContain('set -x');
    expect(workflow).not.toContain('::add-mask::');
  });

  it('fails the job when filing fails: nothing is swallowed or skipped silently', () => {
    expect(workflow).not.toContain('continue-on-error');
    expect(workflow).not.toMatch(/\|\|\s*(true|:|echo)/);
    expect(workflow).not.toContain('fail-fast: false');
    for (const name of TICKET_STEPS) {
      expect(stepBlock(name).join('\n')).not.toContain('continue-on-error');
      expect(stepRun(name)).not.toMatch(/\|\||;|&/);
    }
  });

  it('keeps the secrets in an environment that only the default branch can use', () => {
    // The environment (with its main-only branch policy) is created by the repository owner;
    // the secrets exist only there, so a run from any other ref gets none.
    expect(workflow.match(/environment:/g)).toHaveLength(1);
    expect(jobText(REPORT_JOB)).toMatch(/^ {4}environment: plane-tickets$/m);
  });

  it('can only start on a schedule or by hand, never from a pull request or push', () => {
    const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'));
    const events = [...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(events.sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow).not.toMatch(
      /pull_request|push:|workflow_run|issue_comment|repository_dispatch/,
    );
  });
});
