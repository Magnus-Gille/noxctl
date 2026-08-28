import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'noxctl-embedded-consumer-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: join(scratch, 'npm-cache'),
      npm_config_update_notifier: 'false',
    },
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${output}`);
  }
  return result.stdout;
}

function linkDependency(name, consumerNodeModules) {
  const target = resolve(repoRoot, 'node_modules', ...name.split('/'));
  const link = resolve(consumerNodeModules, ...name.split('/'));
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

try {
  const packDir = join(scratch, 'pack');
  const extractDir = join(scratch, 'extract');
  const consumerDir = join(scratch, 'consumer');
  const consumerNodeModules = join(consumerDir, 'node_modules');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(consumerNodeModules, { recursive: true });

  const packed = JSON.parse(
    run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], repoRoot),
  );
  const tarball = join(packDir, packed[0].filename);
  run('tar', ['-xzf', tarball, '-C', extractDir], repoRoot);

  const packedPackageDir = join(extractDir, 'package');
  const manifest = JSON.parse(readFileSync(join(packedPackageDir, 'package.json'), 'utf8'));
  if (manifest.exports?.['./embedded']?.import !== './dist/embedded.js') {
    throw new Error('Packed package does not expose noxctl/embedded at dist/embedded.js');
  }

  renameSync(packedPackageDir, join(consumerNodeModules, 'noxctl'));
  for (const dependency of ['@modelcontextprotocol/sdk', 'zod', '@types/node']) {
    linkDependency(dependency, consumerNodeModules);
  }

  writeFileSync(join(consumerDir, 'package.json'), '{"type":"module","private":true}\n');
  writeFileSync(
    join(consumerDir, 'runtime.mjs'),
    `import * as embedded from 'noxctl/embedded';
const { createFortnoxClient, createFortnoxOperations, createServer } = embedded;
for (const forbidden of ['startMcpServer', 'bindStartupProfile', 'defaultFortnoxTransport', 'defaultFortnoxOperations']) {
  if (forbidden in embedded) throw new Error(\`Embedded API leaked \${forbidden}\`);
}
const transport = createFortnoxClient({
  getAccessToken: async () => 'consumer-test-token',
  fetch: async () => new Response('{}'),
});
const operations = createFortnoxOperations(transport);
const server = createServer({ transport });
if (typeof operations.getCompanyInfo !== 'function' || typeof server.connect !== 'function') {
  throw new Error('Embedded runtime exports are incomplete');
}
`,
  );
  writeFileSync(
    join(consumerDir, 'consumer.ts'),
    `import {
  createFortnoxClient,
  createFortnoxOperations,
  createServer,
  type CreateFortnoxClientOptions,
  type CreateServerOptions,
  type FortnoxOperations,
  type FortnoxTransport,
} from 'noxctl/embedded';

const clientOptions: CreateFortnoxClientOptions = {
  getAccessToken: async () => 'consumer-test-token',
  fetch: async () => new Response('{}'),
};
const transport: FortnoxTransport = createFortnoxClient(clientOptions);
const operations: FortnoxOperations = createFortnoxOperations(transport);
const serverOptions: CreateServerOptions = { transport };
createServer(serverOptions);
void operations;
`,
  );

  run(process.execPath, ['runtime.mjs'], consumerDir);
  run(
    process.execPath,
    [
      resolve(repoRoot, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'Node16',
      '--moduleResolution',
      'Node16',
      '--target',
      'ES2022',
      'consumer.ts',
    ],
    consumerDir,
  );

  process.stdout.write('Packed noxctl/embedded runtime and type consumer passed.\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
