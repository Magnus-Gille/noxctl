import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('packaging', () => {
  it('excludes dist/pilot from the npm tarball and does not register a bin or export', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.files).toContain('!dist/pilot/');
    expect(JSON.stringify(pkg.bin)).not.toContain('pilot');
    expect(readFileSync('src/embedded.ts', 'utf8')).not.toContain('pilot');
  });
});
