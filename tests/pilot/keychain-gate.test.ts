import { describe, expect, it, vi } from 'vitest';
import { checkFortnoxCompany, checkWriteGate } from '../../src/pilot/gate.js';
import { createKeychainKeyReader } from '../../src/pilot/keychain.js';
import type { ShadowState, ShadowStatus } from '../../src/shadow/types.js';

describe('keychain reader', () => {
  it('uses execFile without a shell and trims one trailing newline', async () => {
    const exec = vi.fn(async () => ({ stdout: 'the-key\n\n' }));
    const key = await createKeychainKeyReader({
      service: 'svc',
      account: 'acct',
      execFileImpl: exec,
    })();
    expect(key).toBe('the-key\n');
    expect(exec).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'svc', '-a', 'acct', '-w'],
      expect.not.objectContaining({ shell: true }),
    );
  });
  it('fails without echoing output', async () => {
    const exec = async () => {
      throw Object.assign(new Error('Command failed: security ... -w'), { stderr: 'secret-ish' });
    };
    const error = await createKeychainKeyReader({
      service: 's',
      account: 'a',
      execFileImpl: exec,
    })().catch((e) => e);
    expect(String(error.message)).not.toContain('secret-ish');
    await expect(
      createKeychainKeyReader({
        service: 's',
        account: 'a',
        execFileImpl: async () => ({ stdout: '\n' }),
      })(),
    ).rejects.toThrow();
  });
});

const NOW = 1_800_000_000_000;
function stub(items: Array<{ id: string; state: ShadowState; createdAt?: number }>) {
  return {
    status: () =>
      ({
        items: items.map((i) => ({ operation: 'createCustomer', createdAt: NOW - 1000, ...i })),
      }) as unknown as ShadowStatus,
  };
}
const gate = (items: Parameters<typeof stub>[0], extra: Record<string, unknown> = {}) =>
  checkWriteGate({ queue: stub(items), now: () => NOW, storageOk: true, ...extra });

describe('write gate', () => {
  it('passes for an empty queue, applied and healthy pending records', () => {
    expect(gate([])).toEqual({ ok: true });
    expect(
      gate([
        { id: 'a', state: 'applied' },
        { id: 'b', state: 'pending' },
      ]),
    ).toEqual({ ok: true });
  });
  it.each([
    'blocked',
    'source_unknown',
    'source_in_flight',
    'target_unknown',
    'target_in_flight',
    'prepared',
    'retry_wait',
    'deferred',
  ] as ShadowState[])('refuses a %s record and names it', (state) => {
    const result = gate([{ id: 'rec-1', state }]);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain('rec-1');
  });
  it('refuses when the oldest unapplied record is older than 24h, but not at the limit', () => {
    expect(gate([{ id: 'o', state: 'pending', createdAt: NOW - 86_400_001 }])).toMatchObject({
      ok: false,
      oldest: { id: 'o' },
    });
    expect(gate([{ id: 'o', state: 'pending', createdAt: NOW - 86_400_000 }])).toEqual({
      ok: true,
    });
    expect(
      gate([{ id: 'o', state: 'pending', createdAt: NOW - 5000 }], { maxAgeMs: 1000 }),
    ).toMatchObject({ ok: false });
  });
  it('refuses when storage or backup failed', () => {
    expect(gate([], { storageOk: false })).toMatchObject({ ok: false });
  });
  it('refuses on executing or unknown staged calls', () => {
    expect(gate([], { stagedStatus: { executing: 1, unknown: 0 } })).toMatchObject({ ok: false });
    expect(gate([], { stagedStatus: { executing: 0, unknown: 1 } })).toMatchObject({ ok: false });
  });
  it('exceptId exempts only that record own pending state', () => {
    const old = { id: 'mine', state: 'pending' as ShadowState, createdAt: NOW - 90_000_000 };
    expect(gate([old], { exceptId: 'mine' })).toEqual({ ok: true });
    expect(gate([{ id: 'x', state: 'target_unknown' }, old], { exceptId: 'mine' })).toMatchObject({
      ok: false,
    });
    expect(gate([{ ...old, state: 'target_unknown' }], { exceptId: 'mine' })).toMatchObject({
      ok: false,
    });
  });
});

describe('Fortnox company check', () => {
  const transport = (org: unknown) =>
    ({ request: async () => ({ CompanyInformation: { OrganizationNumber: org } }) }) as never;
  it('requires an exact organization number', async () => {
    expect(await checkFortnoxCompany(transport('556000-0000'), '556000-0000')).toEqual({
      ok: true,
    });
    expect(await checkFortnoxCompany(transport('5560000000'), '556000-0000')).toMatchObject({
      ok: false,
    });
    expect(await checkFortnoxCompany(transport(' 556000-0000'), '556000-0000')).toMatchObject({
      ok: false,
    });
  });
  it('fails closed when the read throws', async () => {
    const broken = { request: async () => Promise.reject(new Error('down')) } as never;
    expect(await checkFortnoxCompany(broken, '556000-0000')).toMatchObject({ ok: false });
  });
});
