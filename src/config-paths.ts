import os from 'node:os';
import path from 'node:path';

export function configDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || '~';
  return path.join(home, '.fortnox-mcp');
}
