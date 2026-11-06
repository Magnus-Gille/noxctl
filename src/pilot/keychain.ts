import { execFile } from 'node:child_process';

export type ExecFileImpl = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; encoding: 'utf8' },
) => Promise<{ stdout: string }>;

const defaultExec: ExecFileImpl = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) =>
      error ? reject(error) : resolve({ stdout: String(stdout) }),
    );
  });

/** macOS keychain reader. No shell; neither stdout nor stderr ever reaches an error message. */
export function createKeychainKeyReader(options: {
  service: string;
  account: string;
  execFileImpl?: ExecFileImpl;
}): () => Promise<string> {
  const exec = options.execFileImpl ?? defaultExec;
  return async () => {
    let stdout: string;
    try {
      ({ stdout } = await exec(
        '/usr/bin/security',
        ['find-generic-password', '-s', options.service, '-a', options.account, '-w'],
        { timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      ));
    } catch {
      throw new Error('Keychain read failed');
    }
    const key = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
    if (!key) throw new Error('Keychain item is empty');
    return key;
  };
}
