import type { Command, Help } from 'commander';

export const commandGroups: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'Sales',
    [
      'articles',
      'contract-accruals',
      'contracts',
      'customers',
      'invoice-accruals',
      'invoice-payments',
      'invoices',
      'offers',
      'orders',
      'pricelists',
      'prices',
      'recurrings',
      'tax-reductions',
    ],
  ],
  [
    'Purchases',
    ['supplier-invoice-accruals', 'supplier-invoice-payments', 'supplier-invoices', 'suppliers'],
  ],
  [
    'Accounting & reports',
    [
      'accounts',
      'analytics',
      'dashboard',
      'financial-years',
      'general-ledger',
      'reports',
      'tax',
      'vouchers',
    ],
  ],
  [
    'Payroll',
    [
      'absence-transactions',
      'attendance-transactions',
      'employees',
      'salary-transactions',
      'schedule-times',
    ],
  ],
  ['Files', ['archive', 'attachments', 'inbox']],
  [
    'Reference & company setup',
    [
      'account-charts',
      'company',
      'costcenters',
      'currencies',
      'customer-references',
      'modes-of-payments',
      'predefined-accounts',
      'predefined-voucher-series',
      'projects',
      'terms-of-deliveries',
      'terms-of-payments',
      'units',
      'voucher-series',
      'ways-of-delivery',
    ],
  ],
  ['CLI setup', ['completion', 'doctor', 'help', 'init', 'keychain', 'logout', 'profile']],
  ['Integrations', ['serve']],
];

const commonCommands = new Set([
  'customers',
  'dashboard',
  'general-ledger',
  'init',
  'invoices',
  'profile',
  'supplier-invoices',
  'vouchers',
]);

export function validateCommandGroups(names: readonly string[]): void {
  const grouped = commandGroups.flatMap(([, commands]) => [...commands]);
  const known = new Set(names);
  const missing = names.filter((name) => !grouped.includes(name));
  const stale = grouped.filter((name) => !known.has(name));
  const duplicates = grouped.filter((name, index) => grouped.indexOf(name) !== index);
  if (missing.length || stale.length || duplicates.length) {
    throw new Error(
      `CLI help groups out of sync: missing [${missing}], stale [${stale}], duplicate [${duplicates}]`,
    );
  }
}

function rows(items: Array<[string, string]>, helper: Help): string[] {
  const width = Math.max(...items.map(([term]) => term.length));
  return items.map(([term, description]) => helper.formatItem(term, width, description, helper));
}

function rootHelp(program: Command, helper: Help): string {
  const commands = helper.visibleCommands(program);
  validateCommandGroups(commands.map((command) => command.name()));
  const full = Boolean(program.opts().helpAll);
  const output = [
    `Usage: ${helper.commandUsage(program)}`,
    '',
    program.description(),
    '',
    'Options:',
    ...rows(
      helper
        .visibleOptions(program)
        .map((option) => [helper.optionTerm(option), helper.optionDescription(option)]),
      helper,
    ),
    '',
  ];
  if (full) {
    for (const [group, names] of commandGroups) {
      output.push(`${group}:`);
      if (group === 'Payroll')
        output.push('  Requires the salary scope: noxctl init --with-salary');
      output.push(
        ...rows(
          commands
            .filter((command) => names.includes(command.name()))
            .sort((left, right) => left.name().localeCompare(right.name()))
            .map((command) => [
              command.name(),
              group === 'Payroll'
                ? command.description().replace(/ \(requires.*\)$/, '')
                : command.description(),
            ]),
          helper,
        ),
        '',
      );
    }
    output.push('Short overview: noxctl --help');
  } else {
    output.push(
      'Common commands:',
      ...rows(
        commands
          .filter((command) => commonCommands.has(command.name()))
          .map((command) => [command.name(), command.description()]),
        helper,
      ),
      '',
      'All commands by function: noxctl --help-all',
    );
  }
  output.push(
    'Command details: noxctl <command> --help',
    '',
    'Examples:',
    '  noxctl invoices list --filter unpaid',
    '  noxctl --profile demo dashboard',
    '',
  );
  return output.join('\n');
}

/** Configure presentation after registration, without changing the command tree. */
export function configureCliHelp(program: Command): void {
  function configure(command: Command): void {
    command.configureHelp({ sortSubcommands: true, minWidthToWrap: 20 });
    if (command.aliases().length) {
      command.addHelpText('after', `\nAliases: ${command.aliases().join(', ')}`);
    }
    command.commands.forEach(configure);
  }
  configure(program);
  program.configureHelp({ sortSubcommands: true, minWidthToWrap: 20, formatHelp: rootHelp });
}
