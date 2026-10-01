import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import {
  extractCommandTree,
  renderBashCompletion,
  renderZshCompletion,
  renderFishCompletion,
} from '../src/completions.js';

function sampleProgram(): Command {
  const program = new Command();
  program.name('noxctl').option('-o, --output <format>', 'Output format');
  const invoices = program.command('invoices').description('Invoice operations');
  invoices.command('list').option('--filter <filter>', 'Filter').option('-a, --all', 'All pages');
  invoices.command('get <documentNumber>');
  program.command('doctor').description('Diagnose');
  return program;
}

describe('extractCommandTree', () => {
  it('captures nested subcommands and long options', () => {
    const tree = extractCommandTree(sampleProgram());
    expect(tree.name).toBe('noxctl');
    expect(tree.options).toContain('--output');
    const invoices = tree.subcommands.find((c) => c.name === 'invoices');
    expect(invoices).toBeDefined();
    const list = invoices!.subcommands.find((c) => c.name === 'list');
    expect(list!.options).toEqual(expect.arrayContaining(['--filter', '--all']));
    expect(tree.subcommands.map((c) => c.name)).toContain('doctor');
  });
});

describe('renderers', () => {
  const tree = extractCommandTree(sampleProgram());

  it('bash script completes subcommands', () => {
    const script = renderBashCompletion(tree);
    expect(script).toContain('complete -F _noxctl_completions noxctl');
    expect(script).toContain('invoices');
    expect(script).toContain('doctor');
    expect(script).toContain('--filter');
  });

  it('zsh script is a compdef for noxctl', () => {
    const script = renderZshCompletion(tree);
    expect(script).toContain('#compdef noxctl');
    expect(script).toContain('invoices');
    expect(script).toContain('--filter');
  });

  it('fish script registers completions', () => {
    const script = renderFishCompletion(tree);
    expect(script).toContain('complete -c noxctl');
    expect(script).toContain('invoices');
    expect(script).toContain('filter');
  });
});

function richProgram(): Command {
  const program = new Command();
  program
    .name('noxctl')
    .addOption(new Option('-o, --output <format>', 'Output format').choices(['json', 'table']));
  const inv = program.command('supplier-invoices').alias('si').description("Supplier's [docs]: x");
  const list = inv.command('list').description('List things\nsecond line');
  list.option('--input <file>', 'Input file').option('-a, --all', 'All pages');
  list.addOption(new Option('--secret', 'hidden').hideHelp());
  list.option('--note <text>', "It's [a]: note\\ok");
  const nested = inv.command('nested').description('Nested');
  nested.command('deep <file>').description('Deep leaf');
  program.command('inbox').command('upload <file>').description('Upload');
  return program;
}

describe('zsh recursive completion', () => {
  const script = renderZshCompletion(extractCommandTree(richProgram()));

  it('declares value options with argument specs', () => {
    expect(script).toContain("'--input[Input file]:file:_files'");
    expect(script).toContain("'--note[");
    expect(script).toMatch(/'--note\[.*\]:text: '/);
  });

  it('renders choices and short/long exclusion lists', () => {
    expect(script).toContain("'(-o --output)-o[Output format]:format:(json table)'");
    expect(script).toContain("'(-o --output)--output[Output format]:format:(json table)'");
  });

  it('includes ancestor options in leaf functions', () => {
    const fn = script.slice(script.indexOf('_noxctl_supplier_invoices_list() {'));
    expect(fn).toContain('--output');
    expect(fn).toContain('--input');
    expect(fn).toContain('--help');
  });

  it('rebases words with *::arg:->args and dispatches aliases', () => {
    expect(script).toContain("'*::arg:->args'");
    expect(script).toContain('supplier-invoices|si)');
    expect(script).toContain('_noxctl_supplier_invoices');
  });

  it('stops group-level option parsing at the subcommand', () => {
    // Without -A the root consumes options typed after a subcommand
    // (`noxctl invoices -o json li<TAB>`) and the child never sees its words.
    const groups = script.match(/_arguments -C.*/g) ?? [];
    expect(groups.length).toBeGreaterThan(0);
    for (const call of groups) expect(call).toContain("-A '-*'");
  });

  it('generates third-level functions and file positionals', () => {
    expect(script).toContain('_noxctl_supplier_invoices_nested_deep() {');
    expect(script).toContain("'1:file:_files'");
  });

  it('omits hidden options and escapes descriptions', () => {
    expect(script).not.toContain('--secret');
    expect(script).toContain("'\\''");
    expect(script).toContain('\\]');
    expect(script).toContain('List things');
    expect(script).not.toContain('second line');
    expect(script).toContain('supplier-invoices:');
  });

  it('has install footer for both styles', () => {
    expect(script).toContain('#compdef noxctl');
    expect(script).toContain('if [ "$funcstack[1]" = "_noxctl" ]; then');
    expect(script).toContain('compdef _noxctl noxctl');
    expect(script).toContain('source <(noxctl completion zsh)');
  });

  const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0;
  it.skipIf(!hasZsh)('passes zsh -n syntax check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noxctl-zsh-'));
    const file = join(dir, '_noxctl');
    writeFileSync(file, script);
    const r = spawnSync('zsh', ['-n', file], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
