const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

// Windows reserved device names (case-insensitive). Used on all platforms for
// consistency so `noxctl --profile con` is rejected up front, not only on Windows.
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export class InvalidProfileNameError extends Error {
  constructor(name: string, reason: string) {
    super(`Invalid profile name "${name}": ${reason}`);
    this.name = 'InvalidProfileNameError';
  }
}

export function validateProfileName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new InvalidProfileNameError(String(name), 'must be a non-empty string');
  }
  if (name.length > 32) {
    throw new InvalidProfileNameError(name, 'must be at most 32 characters');
  }
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new InvalidProfileNameError(
      name,
      'must start with a letter or digit and contain only letters, digits, dot, underscore, or dash',
    );
  }
  if (WINDOWS_RESERVED.has(name.toLowerCase())) {
    throw new InvalidProfileNameError(name, 'is a reserved device name');
  }
  return name;
}

export function sanitizeForFilename(name: string): string {
  return validateProfileName(name).toLowerCase();
}

export function keychainAccount(profile: string): string {
  const validated = validateProfileName(profile);
  return `profile:${validated.toLowerCase()}`;
}

export const LEGACY_KEYCHAIN_ACCOUNT = 'default';
export const DEFAULT_PROFILE = 'default';
