import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
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
