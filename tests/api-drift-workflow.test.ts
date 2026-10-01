import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/api-drift.yml'), 'utf8');
const workflowLines = workflow.split(/\r?\n/);

/** The lines of one step, from its `- name:` line to the next step or step-level comment. */
function stepBlock(name: string): string[] {
  const start = workflowLines.indexOf(`      - name: ${name}`);
  if (start === -1) throw new Error(`Step not found: ${name}`);
  const rest = workflowLines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {6}(- |# )/.test(line));
  return [workflowLines[start], ...(end === -1 ? rest : rest.slice(0, end))];
}

function stepCondition(name: string): string {
  const line = stepBlock(name).find((l) => l.startsWith('        if: '));
  if (!line) throw new Error(`Step has no condition: ${name}`);
  return line.slice('        if: '.length);
}

function stepScript(name: string): string {
  const block = stepBlock(name);
  const start = block.indexOf('          script: |');
  if (start === -1) throw new Error(`Step has no script: ${name}`);
  return block
    .slice(start + 1)
    .map((line) => line.slice(12))
    .join('\n');
}

type OpenIssue = { number: number; title: string; pull_request?: object };

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<void>;

/** Run a github-script step body against mocked GitHub calls. */
async function runReportScript(name: string, openIssues: OpenIssue[]) {
  const create = vi.fn(async (_params: Record<string, unknown>) => ({}));
  const createComment = vi.fn(async (_params: Record<string, unknown>) => ({}));
  const listForRepo = vi.fn();
  const paginate = vi.fn(async (_method: unknown, _params: Record<string, unknown>) => openIssues);
  const github = { paginate, rest: { issues: { listForRepo, create, createComment } } };
  const context = { repo: { owner: 'owner', repo: 'repo' } };
  const core = { setFailed: vi.fn() };

  await new AsyncFunction('github', 'context', 'core', stepScript(name))(github, context, core);
  return { create, createComment, paginate, listForRepo };
}

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
    // \r? because a Windows checkout may convert line endings.
    expect(workflow).toMatch(/permissions:\r?\n {2}contents: read\r?\n {2}issues: write\r?\n/);
    expect(workflow).not.toContain('contents: write');
    expect(workflow).not.toContain('git push');
    expect(workflow).not.toContain('git commit');
    expect(workflow).not.toContain('git add');
  });

  describe('spec-drift report', () => {
    const step = 'Open issue on API change';
    const unrelated: OpenIssue[] = [
      { number: 5, title: 'MCP write schema drift' },
      { number: 6, title: 'Fortnox API spec fetch failed (2026-09-01)' },
      { number: 7, title: 'Fortnox API spec changed (2026-09-01)', pull_request: {} },
    ];

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('opens one labelled issue when no drift issue is open', async () => {
      vi.stubEnv('DIFF_SUMMARY', 'DRIFT-SUMMARY');
      const { create, createComment, paginate, listForRepo } = await runReportScript(
        step,
        unrelated,
      );

      expect(paginate).toHaveBeenCalledWith(
        listForRepo,
        expect.objectContaining({ state: 'open', labels: 'api-drift' }),
      );
      expect(createComment).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      const issue = create.mock.calls[0][0];
      expect(issue).toMatchObject({ owner: 'owner', repo: 'repo', labels: ['api-drift'] });
      expect(issue.title).toMatch(/^Fortnox API spec changed \(\d{4}-\d{2}-\d{2}\)$/);
      expect(issue.body).toContain('DRIFT-SUMMARY');
      expect(issue.body).toContain('npm run check:api');
      expect(issue.body).not.toContain('fingerprint committed');
    });

    it('comments on the open drift issue instead of opening another', async () => {
      vi.stubEnv('DIFF_SUMMARY', 'DRIFT-SUMMARY');
      const { create, createComment } = await runReportScript(step, [
        ...unrelated,
        { number: 42, title: 'Fortnox API spec changed (2026-09-21)' },
      ]);

      expect(create).not.toHaveBeenCalled();
      expect(createComment).toHaveBeenCalledTimes(1);
      const comment = createComment.mock.calls[0][0];
      expect(comment).toMatchObject({ owner: 'owner', repo: 'repo', issue_number: 42 });
      expect(comment.body).toContain('DRIFT-SUMMARY');
    });
  });

  it('runs every report even when an earlier step has failed', () => {
    // Without !cancelled() a step is skipped as soon as any earlier step fails,
    // so one failed GitHub call would silence the remaining reports.
    const conditions = {
      'Open issue on API change': "steps.diff.outputs.changed == 'true'",
      'Open issue on fetch error': "steps.diff.outputs.error == 'true'",
      'Report MCP write-schema audit':
        "(steps.schema_audit.outputs.changed == 'true' || steps.schema_audit.outputs.error == 'true')",
      'Check implementation coverage':
        "steps.diff.outputs.error != 'true' && steps.schema_audit.outputs.error != 'true'",
    };

    for (const [name, predicate] of Object.entries(conditions)) {
      expect(stepCondition(name)).toBe(`\${{ !cancelled() && ${predicate} }}`);
    }
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
