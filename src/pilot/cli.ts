#!/usr/bin/env node
/** Unpublished pilot operator CLI. Not in package.json "bin"; dist/pilot is excluded from the tarball. */
import { pathToFileURL } from 'node:url';
import { openPilotHost } from './bootstrap.js';
import {
  backupCommand,
  baselineCustomerCommand,
  drainOneCommand,
  linkArticleCommand,
  previewCommand,
  statusCommand,
  type CommandResult,
} from './commands.js';

const USAGE = `usage: node dist/pilot/cli.js --config <file> [--synthetic-source] <command>
  status
  preview <id>
  drain-one <id> <hash>
  baseline-customer <CustomerNumber>
  link-article <ArticleNumber> <targetArticleUuid>
  backup`;

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  let configPath: string | undefined;
  let synthetic = false;
  const rest: string[] = [];
  while (args.length) {
    const arg = args.shift()!;
    if (arg === '--config') configPath = args.shift();
    else if (arg === '--synthetic-source') synthetic = true;
    else rest.push(arg);
  }
  const [command, ...params] = rest;
  const arity: Record<string, number> = {
    status: 0,
    preview: 1,
    'drain-one': 2,
    'baseline-customer': 1,
    'link-article': 2,
    backup: 0,
  };
  if (!configPath || !command || arity[command] !== params.length) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const host = await openPilotHost({ configPath, synthetic });
  try {
    let result: CommandResult;
    switch (command) {
      case 'status':
        result = await statusCommand(host);
        break;
      case 'preview':
        result = await previewCommand(host, params[0]!);
        break;
      case 'drain-one':
        result = await drainOneCommand(host, params[0]!, params[1]!);
        break;
      case 'baseline-customer':
        result = await baselineCustomerCommand(host, params[0]!);
        break;
      case 'link-article':
        result = await linkArticleCommand(host, params[0]!, params[1]!);
        break;
      default:
        result = await backupCommand(host);
    }
    process.stdout.write(`${result.message}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `pilot: ${error instanceof Error ? `${error.name}: ${error.message}` : 'failed'}\n` +
        'The outcome of the interrupted step may be unknown: run `status`; never retry blindly.\n',
    );
    return 2;
  } finally {
    await host.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`pilot: ${error instanceof Error ? error.message : 'failed'}\n`);
      process.exit(2);
    },
  );
}
