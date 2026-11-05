import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { openShadowQueue, type ShadowQueue } from './queue.js';
import type { OperationObserver, ShadowBinding } from './types.js';

export interface LocalShadowConfig extends ShadowBinding {
  version: 1;
  profile: string;
  directory: string;
}

/** Explicit local operator configuration. Contains identities and paths, never credentials. */
export function loadLocalShadowConfig(path: string, profile: string): LocalShadowConfig {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 8192 ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Shadow configuration must be an owned regular file, not writable by others');
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid shadow configuration');
  const config = raw as Record<string, unknown>;
  const keys = ['version', 'profile', 'directory', 'sourceCompany', 'targetCompany'];
  if (
    Object.keys(config).length !== keys.length ||
    keys.some((key) => !(key in config)) ||
    config.version !== 1
  )
    throw new Error('Invalid shadow configuration fields/version');
  for (const key of keys.filter((key) => key !== 'version')) {
    if (
      typeof config[key] !== 'string' ||
      !(config[key] as string).trim() ||
      /[\x00-\x1f]/.test(config[key] as string)
    )
      throw new Error(`Invalid shadow configuration: ${key}`);
  }
  if (config.profile !== profile)
    throw new Error('Shadow configuration does not match the resolved Fortnox profile');
  if (!isAbsolute(config.directory as string)) throw new Error('Shadow directory must be absolute');
  return config as unknown as LocalShadowConfig;
}

export async function createLocalShadowObserver(
  config: LocalShadowConfig,
  baseIntent: string | undefined,
  getCompany: () => Promise<Record<string, unknown>>,
): Promise<{ observer: OperationObserver; queue: ShadowQueue }> {
  if (baseIntent !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(baseIntent))
    throw new Error('Shadow intent must be 1-128 letters, digits, underscores or hyphens');
  const queue = await openShadowQueue(config.directory, {
    sourceCompany: config.sourceCompany,
    targetCompany: config.targetCompany,
  });
  let sequence = 0;
  return {
    queue,
    observer: {
      async execute(operation, args, invoke) {
        if (!baseIntent)
          throw new Error(
            'Shadow writes require --shadow-intent with a stable unique command identity; reuse it only to recover the same command',
          );
        // This read happens after the ordinary CLI confirmation/dry-run gate, before any business dispatch.
        const company = await getCompany();
        if (company.OrganizationNumber !== config.sourceCompany)
          throw new Error('Fortnox company identity does not match the shadow binding');
        const id = `${baseIntent}:${sequence++}`;
        return queue.execute({ id, operation, args }, invoke);
      },
      status: () => queue.status(),
    },
  };
}
