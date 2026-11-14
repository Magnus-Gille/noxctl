/** Environment variable that starts the MCP server in read-only mode. */
export const READ_ONLY_ENV = 'NOXCTL_READ_ONLY';

/** Raised for an unrecognized NOXCTL_READ_ONLY value; the server must not start. */
export class InvalidReadOnlyEnvError extends Error {
  constructor() {
    super(
      `${READ_ONLY_ENV} has an invalid value. Use 1 or true for read-only mode, or leave it unset or use 0 or false for full mode.`,
    );
    this.name = 'InvalidReadOnlyEnvError';
  }
}

/**
 * Parse NOXCTL_READ_ONLY. Unset or empty and 0/false (any case) mean off;
 * 1/true (any case) mean on. Any other value throws, so a misspelling can never
 * silently start a writable server. The rejected value is not echoed.
 */
export function parseReadOnlyEnv(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const normalized = value.toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new InvalidReadOnlyEnvError();
}
