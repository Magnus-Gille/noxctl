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
    expect(script).toContain("'--input=[Input file]:file:_files'");
    expect(script).toContain("'--note=[");
    expect(script).toMatch(/'--note=\[.*\]:text: '/);
  });

  it('renders choices and short/long exclusion lists', () => {
    expect(script).toContain(
      "'(-o --output)-o[Output format]:format:('\\''json'\\'' '\\''table'\\'')'",
    );
    expect(script).toContain(
      "'(-o --output)--output=[Output format]:format:('\\''json'\\'' '\\''table'\\'')'",
    );
  });

  it('includes ancestor options in leaf functions', () => {
    const start = script.indexOf('_noxctl_supplier_invoices_list() {');
    const fn = script.slice(start, script.indexOf('\n}\n', start));
    expect(fn).toContain('--output');
    expect(fn).toContain('--input');
    expect(fn).toContain('--help');
  });

  it('rebases words with *::arg:->args and dispatches aliases', () => {
    expect(script).toContain("'*::arg:->args'");
    expect(script).toContain("'supplier-invoices'|'si')");
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

const q = (str: string) => `'${str.replace(/'/g, "'\\''")}'`;

function funcBody(script: string, name: string): string {
  const start = script.indexOf(`${name}() {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return script.slice(start, script.indexOf('\n}\n', start));
}

describe('zsh completion hardening', () => {
  it('quotes hostile and awkward choices as single words', () => {
    const p = new Command().name('noxctl');
    const choices = ['`pwd`', 'two words', "it's", 'a(b)', '$HOME', 'x:y'];
    p.addOption(new Option('--mode <m>', 'Mode').choices(choices));
    const script = renderZshCompletion(extractCommandTree(p));
    for (const c of choices) {
      expect(script).toContain(q(c.replace(/:/g, '\\:')).replace(/'/g, "'\\''"));
    }
  });

  it('uses = on value-taking long flags only', () => {
    const p = new Command().name('noxctl');
    p.option('--val <v>', 'V')
      .option('--opt [v]', 'O')
      .option('--flag', 'F')
      .option('-s, --sh <x>', 'S');
    const script = renderZshCompletion(extractCommandTree(p));
    expect(script).toContain("'--val=[V]:v: '");
    expect(script).toContain("'--opt=[O]::v: '");
    expect(script).toContain("'--flag[F]'");
    expect(script).toContain("'(-s --sh)-s[S]:x: '");
    expect(script).toContain("'(-s --sh)--sh=[S]:x: '");
  });

  it('assigns collision-free function names and dispatches to them', () => {
    const p = new Command().name('noxctl');
    p.command('foo-bar').command('x');
    p.command('foo_bar').command('x');
    p.command('a_b');
    p.command('a').command('b');
    const script = renderZshCompletion(extractCommandTree(p));
    const names = [...script.matchAll(/^(_noxctl\w*)\(\) \{$/gm)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(1 + 4 + 2 + 1);
    const dispatch = [...script.matchAll(/\) (_noxctl\w+) ;;/g)].map((m) => m[1]);
    expect(new Set(dispatch).size).toBe(dispatch.length);
    for (const d of dispatch) expect(names).toContain(d);
  });

  it('emits literal quoted case patterns', () => {
    const p = new Command().name('noxctl');
    const g = p.command('we?ird*').alias('x y');
    g.command('leaf');
    const script = renderZshCompletion(extractCommandTree(p));
    expect(script).toContain("'we?ird*'|'x y')");
  });

  it('keeps an ancestor long flag when a child reuses its short flag', () => {
    const p = new Command().name('noxctl').option('-o, --output <f>', 'Out');
    p.command('sub').option('-o, --offset <n>', 'Off');
    const script = renderZshCompletion(extractCommandTree(p));
    const body = funcBody(script, '_noxctl_sub');
    expect(body).toContain("'--output=[Out]:f: '");
    expect(body).not.toContain('(-o --output)');
    expect(body).toContain("'(-o --offset)-o[Off]:n: '");
    expect(body).toContain("'(-o --offset)--offset=[Off]:n: '");
  });

  it('replaces an ancestor entry that has the same long flag', () => {
    const p = new Command().name('noxctl').option('--x <a>', 'Parent');
    p.command('sub').option('--x <b>', 'Child');
    const body = funcBody(renderZshCompletion(extractCommandTree(p)), '_noxctl_sub');
    expect(body).toContain("'--x=[Child]:b: '");
    expect(body).not.toContain('Parent');
  });

  it('keeps -h, --host and still offers --help', () => {
    const p = new Command().name('noxctl');
    p.command('sub').option('-h, --host <h>', 'Host');
    const body = funcBody(renderZshCompletion(extractCommandTree(p)), '_noxctl_sub');
    expect(body).toContain("'(-h --host)-h[Host]:h: '");
    expect(body).toContain("'(-h --host)--host=[Host]:h: '");
    expect(body).toContain("'--help[");
    expect(body).not.toContain('(-h --help)');
  });

  it('omits hidden commands from zsh only', () => {
    const p = new Command().name('noxctl');
    p.command('visible').description('V');
    p.command('secretcmd', { hidden: true }).description('S');
    const tree = extractCommandTree(p);
    expect(renderZshCompletion(tree)).not.toContain('secretcmd');
    expect(renderBashCompletion(tree)).toContain('secretcmd');
    expect(renderFishCompletion(tree)).toContain('secretcmd');
  });
});
