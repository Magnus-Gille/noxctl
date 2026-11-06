import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeJournal, PilotRegistryError } from '../../src/pilot/journal.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pilot-registry-'));
  roots.push(root);
  const headDir = join(root, 'heads');
  const a = join(root, 'a');
  const b = join(root, 'b');
  mkdirSync(a, { mode: 0o700 });
  mkdirSync(b, { mode: 0o700 });
  return { headDir, a, b };
}
const bindingA = {
  sourceCompany: '556000-0001',
  targetCompany: '11111111-1111-4111-8111-111111111111',
};
const bindingB = {
  sourceCompany: '556000-0002',
  targetCompany: '22222222-2222-4222-8222-222222222222',
};

describe('pilot registry lock (NOX-214 review round 4)', () => {
  it('refuses to initialize while another process holds the registry lock', () => {
    const { headDir, a } = setup();
    mkdirSync(headDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(headDir, 'registry.lock'), '{"pid":1}', { mode: 0o600 });
    expect(() => initializeJournal({ directory: a, headDir }, 1, bindingA)).toThrow(
      PilotRegistryError,
    );
    expect(existsSync(join(a, 'pilot-id'))).toBe(false);
  });

  it('keeps both entries when two pilots initialize one after another and releases the lock', () => {
    const { headDir, a, b } = setup();
    const idA = initializeJournal({ directory: a, headDir }, 1, bindingA);
    const idB = initializeJournal({ directory: b, headDir }, 2, bindingB);
    const registry = JSON.parse(readFileSync(join(headDir, 'registry.json'), 'utf8'));
    expect(registry.entries.map((e: { pilotId: string }) => e.pilotId).sort()).toEqual(
      [idA, idB].sort(),
    );
    expect(existsSync(join(headDir, 'registry.lock'))).toBe(false);
  });
});
