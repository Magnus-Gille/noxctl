import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createAccountedClient } from './accounted-client.js';
import { createPilotHost, loadPilotConfig, type PilotHost } from './host.js';
import { createKeychainKeyReader } from './keychain.js';
import { createSyntheticFortnox } from './synthetic.js';

export interface OpenPilotHostOptions {
  configPath: string;
  /** Rehearsal: swap Fortnox for the deterministic in-memory transport (org nr from config). */
  synthetic?: boolean;
  /** Journal head/registry directory; defaults to ~/Library/Application Support/noxctl-pilot. */
  headDir?: string;
}

/** Shared by the pilot CLI and MCP server: same profile/auth as `noxctl`, no new auth code. */
export async function openPilotHost(options: OpenPilotHostOptions): Promise<PilotHost> {
  const config = loadPilotConfig(options.configPath);
  let fortnox;
  if (options.synthetic) {
    // Shared on disk in the pilot directory so the CLI and the MCP server see the same records.
    fortnox = createSyntheticFortnox(config.sourceCompany, {
      persistPath: join(config.directory, 'synthetic-fortnox.json'),
    }).transport;
  } else {
    const { setResolvedProfile } = await import('../auth.js');
    const { defaultFortnoxTransport } = await import('../fortnox-client.js');
    setResolvedProfile(config.profile, 'flag');
    fortnox = defaultFortnoxTransport;
  }
  return createPilotHost(config, {
    ...(options.headDir ? { headDir: options.headDir } : {}),
    fortnox,
    accounted: createAccountedClient({
      origin: config.accountedOrigin,
      companyId: config.targetCompany,
      apiKey: createKeychainKeyReader({
        service: config.keychainService,
        account: config.keychainAccount,
      }),
    }),
    // Read from the OS, not from an environment variable the caller can set.
    osUser: () => userInfo().username,
  });
}
