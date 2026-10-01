import type { Command, Option } from 'commander';

export interface OptionNode {
  long?: string;
  short?: string;
  description: string;
  takesValue: boolean;
  valueOptional: boolean;
  valueName?: string;
  choices?: string[];
  variadic: boolean;
}

export interface ArgumentNode {
  name: string;
  required: boolean;
  variadic: boolean;
  choices?: string[];
}

export interface CommandNode {
  name: string;
  description: string;
  /** Long flags only (used by the bash and fish renderers). */
  options: string[];
  subcommands: CommandNode[];
  aliases: string[];
  optionDetails: OptionNode[];
  args: ArgumentNode[];
}

function firstLine(text: string): string {
  return (text ?? '').split('\n')[0].trim();
}

function extractOption(o: Option): OptionNode {
  const placeholder = /[<[]\s*([^\]>.\s]+)(?:\.\.\.)?\s*[>\]]/.exec(o.flags);
  const takesValue = Boolean(o.required || o.optional);
  return {
    long: o.long,
    short: o.short,
    description: firstLine(o.description),
    takesValue,
    valueOptional: Boolean(o.optional),
    valueName: takesValue ? (placeholder?.[1] ?? 'value') : undefined,
    choices: o.argChoices && o.argChoices.length > 0 ? [...o.argChoices] : undefined,
    variadic: Boolean(o.variadic),
  };
}

export function extractCommandTree(cmd: Command): CommandNode {
  return {
    name: cmd.name(),
    description: cmd.description(),
    options: cmd.options.map((o) => o.long).filter((l): l is string => Boolean(l)),
    aliases: cmd.aliases(),
    optionDetails: cmd.options.filter((o) => !o.hidden).map(extractOption),
    args: cmd.registeredArguments.map((a) => ({
      name: a.name(),
      required: a.required,
      variadic: a.variadic,
      choices: a.argChoices && a.argChoices.length > 0 ? [...a.argChoices] : undefined,
    })),
    subcommands: cmd.commands
      .filter((sub) => sub.name() !== 'help' && !(sub as unknown as { _hidden?: boolean })._hidden)
      .map((sub) => extractCommandTree(sub as Command)),
  };
}

function shellEscapeSingle(str: string): string {
  return str.replace(/'/g, "'\\''");
}

export function renderBashCompletion(tree: CommandNode): string {
  const lines: string[] = [
    '# bash completion for noxctl',
    '# Install: noxctl completion bash > /usr/local/etc/bash_completion.d/noxctl',
    '#      or: eval "$(noxctl completion bash)"',
    '_noxctl_completions() {',
    '  local cur prev words',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  local cmd="" sub=""',
    '  local i',
    '  for ((i=1; i < COMP_CWORD; i++)); do',
    '    case "${COMP_WORDS[i]}" in',
    '      -*) continue ;;',
    '      *) if [[ -z "$cmd" ]]; then cmd="${COMP_WORDS[i]}"; elif [[ -z "$sub" ]]; then sub="${COMP_WORDS[i]}"; fi ;;',
    '    esac',
    '  done',
    '  local opts=""',
    '  if [[ -z "$cmd" ]]; then',
    `    opts="${tree.subcommands.map((c) => c.name).join(' ')} ${tree.options.join(' ')}"`,
    '  else',
    '    case "$cmd" in',
  ];

  for (const cmd of tree.subcommands) {
    lines.push(`      ${cmd.name})`);
    if (cmd.subcommands.length > 0) {
      lines.push('        if [[ -z "$sub" ]]; then');
      lines.push(
        `          opts="${cmd.subcommands.map((c) => c.name).join(' ')} ${cmd.options.join(' ')}"`,
      );
      lines.push('        else');
      lines.push('          case "$sub" in');
      for (const sub of cmd.subcommands) {
        lines.push(`            ${sub.name}) opts="${sub.options.join(' ')}" ;;`);
      }
      lines.push('          esac');
      lines.push('        fi');
    } else {
      lines.push(`        opts="${cmd.options.join(' ')}"`);
    }
    lines.push('        ;;');
  }

  lines.push(
    '    esac',
    '  fi',
    '  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )',
    '}',
    'complete -F _noxctl_completions noxctl',
    '',
  );
  return lines.join('\n');
}

const FILE_LIKE = /^(file|files|path|dir|directory)$/i;

/** Escape for the description inside [...] of an _arguments spec (before single-quoting). */
function escapeSpecDescription(str: string): string {
  return firstLine(str).replace(/[\\\]:]/g, '\\$&');
}

function zshFunctionName(path: string[]): string {
  return ['_noxctl', ...path].join('_').replace(/[^A-Za-z0-9_]/g, '_');
}

function safeLabel(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '') || 'value';
}

function zshValueSpec(name: string, choices: string[] | undefined, optional: boolean): string {
  const colons = optional ? '::' : ':';
  const label = safeLabel(name);
  if (choices && choices.length > 0) {
    return `${colons}${label}:(${choices.map((c) => c.replace(/[\s()'\\]/g, '')).join(' ')})`;
  }
  if (FILE_LIKE.test(name)) return `${colons}${label}:_files`;
  return `${colons}${label}: `;
}

function zshOptionSpecs(opt: OptionNode): string[] {
  const flags = [opt.short, opt.long].filter((f): f is string => Boolean(f));
  const desc = escapeSpecDescription(opt.description);
  const value = opt.takesValue
    ? zshValueSpec(opt.valueName ?? 'value', opt.choices, opt.valueOptional)
    : '';
  return flags.map((flag) => {
    const prefix = opt.variadic ? '*' : flags.length > 1 ? `(${flags.join(' ')})` : '';
    return shellQuote(`${prefix}${flag}[${desc}]${value}`);
  });
}

function shellQuote(str: string): string {
  return `'${shellEscapeSingle(str)}'`;
}

function describeEntries(nodes: CommandNode[]): string[] {
  const entries: string[] = [];
  for (const n of nodes) {
    const desc = firstLine(n.description) || n.name;
    for (const name of [n.name, ...n.aliases]) {
      entries.push(shellQuote(`${name.replace(/:/g, '\\:')}:${desc}`));
    }
  }
  return entries;
}

function zshPositionalSpecs(args: ArgumentNode[]): string[] {
  return args.map((a, i) => {
    const optional = !a.required;
    if (a.variadic) {
      return shellQuote(`*${zshValueSpec(a.name, a.choices, false)}`);
    }
    return shellQuote(`${i + 1}${zshValueSpec(a.name, a.choices, optional)}`);
  });
}

const HELP_OPTION: OptionNode = {
  long: '--help',
  short: '-h',
  description: 'display help for command',
  takesValue: false,
  valueOptional: false,
  variadic: false,
};

function emitZshNode(
  node: CommandNode,
  path: string[],
  inherited: Map<string, OptionNode>,
  lines: string[],
): void {
  const merged = new Map(inherited);
  for (const o of [...node.optionDetails, HELP_OPTION]) {
    // Drop any ancestor entry sharing either flag so the descendant wins.
    for (const [k, v] of merged) {
      if ((o.long && v.long === o.long) || (o.short && v.short === o.short)) merged.delete(k);
    }
    merged.set(o.long ?? o.short ?? '', o);
  }
  const optSpecs = [...merged.values()].flatMap(zshOptionSpecs);
  const fn = zshFunctionName(path);
  const isGroup = node.subcommands.length > 0;

  // Children first so each function is defined before the dispatcher runs.
  for (const sub of node.subcommands) {
    emitZshNode(sub, [...path, sub.name], merged, lines);
  }

  const specs = isGroup
    ? [...optSpecs, "'1: :->command'", "'*::arg:->args'"]
    : [...optSpecs, ...zshPositionalSpecs(node.args)];

  lines.push(`${fn}() {`);
  if (isGroup) {
    lines.push('  local curcontext="$curcontext" state line');
    lines.push('  local -a commands');
    lines.push("  _arguments -C -A '-*' \\");
  } else {
    lines.push('  _arguments \\');
  }
  specs.forEach((spec, i) => lines.push(`    ${spec}${i < specs.length - 1 ? ' \\' : ''}`));
  if (isGroup) {
    lines.push('  case $state in');
    lines.push('    command)');
    lines.push('      commands=(');
    for (const e of describeEntries(node.subcommands)) lines.push(`        ${e}`);
    lines.push('      )');
    lines.push("      _describe -t commands 'command' commands");
    lines.push('      ;;');
    lines.push('    args)');
    lines.push('      case $words[1] in');
    for (const sub of node.subcommands) {
      const names = [sub.name, ...sub.aliases].map((n) => n.replace(/[^A-Za-z0-9_.-]/g, '?'));
      lines.push(`        ${names.join('|')}) ${zshFunctionName([...path, sub.name])} ;;`);
    }
    lines.push('      esac');
    lines.push('      ;;');
    lines.push('  esac');
  }
  lines.push('}', '');
}

export function renderZshCompletion(tree: CommandNode): string {
  const lines: string[] = [
    '#compdef noxctl',
    '# zsh completion for noxctl',
    '# Install: noxctl completion zsh > "${fpath[1]}/_noxctl" && compinit',
    '#      or: source <(noxctl completion zsh)',
    '',
  ];
  emitZshNode(tree, [], new Map(), lines);
  lines.push(
    'if [ "$funcstack[1]" = "_noxctl" ]; then',
    '  _noxctl "$@"',
    'else',
    '  compdef _noxctl noxctl',
    'fi',
    '',
  );
  return lines.join('\n');
}

export function renderFishCompletion(tree: CommandNode): string {
  const lines: string[] = [
    '# fish completion for noxctl',
    '# Install: noxctl completion fish > ~/.config/fish/completions/noxctl.fish',
    '',
  ];

  const topNames = tree.subcommands.map((c) => c.name).join(' ');
  for (const cmd of tree.subcommands) {
    lines.push(
      `complete -c noxctl -f -n "not __fish_seen_subcommand_from ${topNames}" -a ${cmd.name} -d '${shellEscapeSingle(cmd.description || '')}'`,
    );
    const subNames = cmd.subcommands.map((c) => c.name).join(' ');
    for (const sub of cmd.subcommands) {
      lines.push(
        `complete -c noxctl -f -n "__fish_seen_subcommand_from ${cmd.name}; and not __fish_seen_subcommand_from ${subNames}" -a ${sub.name} -d '${shellEscapeSingle(sub.description || '')}'`,
      );
      for (const opt of sub.options) {
        lines.push(
          `complete -c noxctl -f -n "__fish_seen_subcommand_from ${sub.name}" -l ${opt.replace(/^--/, '')}`,
        );
      }
    }
    for (const opt of cmd.options) {
      lines.push(
        `complete -c noxctl -f -n "__fish_seen_subcommand_from ${cmd.name}" -l ${opt.replace(/^--/, '')}`,
      );
    }
  }
  for (const opt of tree.options) {
    lines.push(`complete -c noxctl -l ${opt.replace(/^--/, '')}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderCompletion(shell: string, tree: CommandNode): string {
  switch (shell) {
    case 'bash':
      return renderBashCompletion(tree);
    case 'zsh':
      return renderZshCompletion(tree);
    case 'fish':
      return renderFishCompletion(tree);
    default:
      throw new Error(`Unsupported shell "${shell}". Supported: bash, zsh, fish.`);
  }
}
