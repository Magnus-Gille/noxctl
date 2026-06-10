import type { Command } from 'commander';

export interface CommandNode {
  name: string;
  description: string;
  options: string[];
  subcommands: CommandNode[];
}

export function extractCommandTree(cmd: Command): CommandNode {
  return {
    name: cmd.name(),
    description: cmd.description(),
    options: cmd.options.map((o) => o.long).filter((l): l is string => Boolean(l)),
    subcommands: cmd.commands
      .filter((sub) => sub.name() !== 'help')
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

export function renderZshCompletion(tree: CommandNode): string {
  const lines: string[] = [
    '#compdef noxctl',
    '# zsh completion for noxctl',
    '# Install: noxctl completion zsh > "${fpath[1]}/_noxctl" && compinit',
    '',
    '_noxctl() {',
    '  local -a commands',
    '  local curcontext="$curcontext" state line',
    '  _arguments -C \\',
    ...tree.options.map((o) => `    '${o}[option]' \\`),
    "    '1: :->command' \\",
    "    '*: :->args'",
    '',
    '  case $state in',
    '    command)',
    '      commands=(',
    ...tree.subcommands.map(
      (c) => `        '${c.name}:${shellEscapeSingle(c.description || c.name)}'`,
    ),
    '      )',
    "      _describe 'command' commands",
    '      ;;',
    '    args)',
    '      case $words[2] in',
  ];

  for (const cmd of tree.subcommands) {
    if (cmd.subcommands.length === 0 && cmd.options.length === 0) continue;
    lines.push(`        ${cmd.name})`);
    if (cmd.subcommands.length > 0) {
      lines.push('          local -a subcommands');
      lines.push('          subcommands=(');
      for (const sub of cmd.subcommands) {
        lines.push(`            '${sub.name}:${shellEscapeSingle(sub.description || sub.name)}'`);
      }
      lines.push('          )');
      lines.push('          if (( CURRENT == 3 )); then');
      lines.push("            _describe 'subcommand' subcommands");
      lines.push('          else');
      lines.push('            case $words[3] in');
      for (const sub of cmd.subcommands) {
        if (sub.options.length === 0) continue;
        lines.push(
          `              ${sub.name}) _arguments ${sub.options.map((o) => `'${o}[option]'`).join(' ')} ;;`,
        );
      }
      lines.push('            esac');
      lines.push('          fi');
    } else {
      lines.push(`          _arguments ${cmd.options.map((o) => `'${o}[option]'`).join(' ')}`);
    }
    lines.push('          ;;');
  }

  lines.push('      esac', '      ;;', '  esac', '}', '', '_noxctl "$@"', '');
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
