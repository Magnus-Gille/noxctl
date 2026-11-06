#!/usr/bin/env node
/** Unpublished pilot MCP stdio entry: the five staged tools with the pilot gate and backups. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { openPilotHost } from './bootstrap.js';

export async function main(argv: string[]): Promise<void> {
  let configPath: string | undefined;
  let synthetic = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configPath = argv[++i];
    else if (argv[i] === '--synthetic-source') synthetic = true;
    else throw new Error('usage: server.js --config <file> [--synthetic-source]');
  }
  if (!configPath) throw new Error('usage: server.js --config <file> [--synthetic-source]');
  const host = await openPilotHost({ configPath, synthetic });
  if (synthetic) host.log('pilot: SYNTHETIC Fortnox source (rehearsal)');
  await host.staged.server.connect(host.wrapTransport(new StdioServerTransport()));
  const stop = () => void host.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`pilot: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exit(1);
  });
}
