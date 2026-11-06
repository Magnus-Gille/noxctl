import { copyFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backupCommand,
  baselineCustomerCommand,
  drainOneCommand,
  previewCommand,
  refuseCommand,
  statusCommand,
} from '../../src/pilot/commands.js';
import { verifyJournal } from '../../src/pilot/journal.js';
import { makeHost } from './helpers.js';

type Made = Awaited<ReturnType<typeof makeHost>>;

/** An invoice the mapping refuses (no InvoiceDate), recorded the way the staged server does. */
async function unmappable(h: Made, id: string) {
  await h.host.queue.execute(
    {
      id,
      operation: 'createInvoice',
      args: [
        {
          CustomerNumber: '1',
          Currency: 'SEK',
          DueDate: '2026-11-29',
          InvoiceRows: [{ Description: 'x', DeliveredQuantity: 1, Price: 1, VAT: 25, Unit: 'st' }],
        },
      ],
    },
    async () => ({ DocumentNumber: '77' }),
  );
}
const latestBackup = (h: Made) => readdirSync(join(h.config.directory, 'backups')).sort().at(-1);
const journal = (h: Made) =>
  (verifyJournal({ directory: h.host.directory, headDir: h.headDir }) as { entries: unknown[] })
    .entries;
const save = (h: Made, id: string, change: (r: Record<string, unknown>) => void) => {
  const record = h.host.queue.get(id) as unknown as Record<string, unknown>;
  change(record);
  (h.host.queue as unknown as { save(r: unknown): void }).save(record);
};

describe('refuse (NOX-215)', () => {
  it('blocks an unmappable head record, journals it, backs up, opens the gate and lets the next drain', async () => {
    const h = await makeHost();
    await unmappable(h, 'bad-1');
    expect((await previewCommand(h.host, 'bad-1')).ok).toBe(false);
    expect(await h.host.checkGate()).toMatchObject({ ok: true });
    await baselineCustomerCommand(h.host, '1');
    const next = h.host.queue.snapshot()[1]!.record.id;
    const backupsBefore = readdirSync(join(h.config.directory, 'backups')).length;
    const result = await refuseCommand(h.host, 'bad-1', 'wrong dates');
    expect(result.ok, result.message).toBe(true);
    const record = h.host.queue.get('bad-1')!;
    expect(record.state).toBe('blocked');
    expect(record.reason).toMatch(/^OPERATOR_REFUSED: wrong dates \(mapping: .*InvoiceDate/);
    expect(journal(h).at(-1)).toMatchObject({ kind: 'refused', intentId: 'bad-1' });
    expect(readdirSync(join(h.config.directory, 'backups')).length).toBeGreaterThan(backupsBefore);
    expect(h.accounted.calls).toEqual([]);
    expect(h.synthetic.state.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    expect(await h.host.checkGate()).toEqual({ ok: true });
    expect((await statusCommand(h.host)).message).toMatch(/bad-1 createInvoice blocked/);
    const preview = await previewCommand(h.host, next);
    expect(preview.ok, preview.message).toBe(true);
    const drained = await drainOneCommand(h.host, next, preview.hash!);
    expect(drained.ok, drained.message).toBe(true);
    expect(h.host.queue.get(next)!.state).toBe('applied');
  });

  it('refuses a mappable record, a non-oldest record, and bad reasons', async () => {
    const h = await makeHost();
    await baselineCustomerCommand(h.host, '1');
    const mappable = h.host.queue.snapshot()[0]!.record.id;
    expect((await refuseCommand(h.host, mappable, 'no')).ok).toBe(false);
    expect(h.host.queue.get(mappable)!.state).toBe('pending');
    // Both unmappable; the second is not the oldest.
    const h2 = await makeHost();
    await unmappable(h2, 'bad-1');
    await unmappable(h2, 'bad-2');
    expect((await refuseCommand(h2.host, 'bad-2', 'no')).ok).toBe(false);
    expect(h2.host.queue.get('bad-2')!.state).toBe('pending');
    expect((await refuseCommand(h2.host, 'bad-1', '')).ok).toBe(false);
    expect((await refuseCommand(h2.host, 'bad-1', 'x\ny')).ok).toBe(false);
    expect((await refuseCommand(h2.host, 'missing', 'no')).ok).toBe(false);
    expect(h2.host.queue.get('bad-1')!.state).toBe('pending');
  });

  it('refuses a record with target attempts, a target_unknown record and a blocked one', async () => {
    const h = await makeHost();
    await unmappable(h, 'bad-1');
    save(h, 'bad-1', (r) => (r.targetAttempts = 1));
    expect((await refuseCommand(h.host, 'bad-1', 'no')).ok).toBe(false);
    const adapter = h.host.adapterFor('createInvoice')!;
    expect(await h.host.queue.refuseUnmappable('bad-1', 'no', adapter)).toMatchObject({
      ok: false,
    });
    expect(h.host.queue.get('bad-1')!.state).toBe('pending');

    save(h, 'bad-1', (r) => {
      r.targetAttempts = 0;
      r.state = 'target_unknown';
    });
    expect((await refuseCommand(h.host, 'bad-1', 'no')).ok).toBe(false);
    expect(await h.host.queue.refuseUnmappable('bad-1', 'no', adapter)).toMatchObject({
      ok: false,
    });
    expect(h.host.queue.get('bad-1')!.state).toBe('target_unknown');

    save(h, 'bad-1', (r) => {
      r.state = 'pending';
    });
    save(h, 'bad-1', (r) => {
      r.targetId = '00000000-0000-4000-8000-000000000001';
    });
    expect(await h.host.queue.refuseUnmappable('bad-1', 'no', adapter)).toMatchObject({
      ok: false,
    });
  });

  it('other blocked records keep holding the queue and the gate', async () => {
    const h = await makeHost();
    await unmappable(h, 'bad-1');
    await baselineCustomerCommand(h.host, '1');
    // The ordinary drain blocks the unmappable head record by itself.
    await h.host.queue.drainOne(h.host.adapterFor('createInvoice')!);
    expect(h.host.queue.get('bad-1')!.state).toBe('blocked');
    expect(h.host.queue.get('bad-1')!.reason).not.toMatch(/^OPERATOR_REFUSED/);
    expect(await h.host.checkGate()).toMatchObject({ ok: false });
    const next = h.host.queue.snapshot()[1]!.record.id;
    expect((await previewCommand(h.host, next)).ok).toBe(false);
    expect((await refuseCommand(h.host, 'bad-1', 'no')).ok).toBe(false);
    // A forged reason without a journal entry does not open the gate.
    save(h, 'bad-1', (r) => (r.reason = 'OPERATOR_REFUSED: forged'));
    expect(await h.host.checkGate()).toMatchObject({ ok: false });
    const forgedPreview = await previewCommand(h.host, next);
    expect(forgedPreview.ok, forgedPreview.message).toBe(true);
    const forgedDrain = await drainOneCommand(h.host, next, forgedPreview.hash!);
    expect(forgedDrain.ok).toBe(false);
    expect(forgedDrain.message).toMatch(/write gate/);
    expect(h.host.queue.get(next)!.state).toBe('pending');
  });

  it('a restored backup that has the record pending while the journal says refused is refused', async () => {
    const h = await makeHost();
    await unmappable(h, 'bad-1');
    await backupCommand(h.host);
    const snapshot = join(h.config.directory, 'backups', latestBackup(h)!);
    expect((await refuseCommand(h.host, 'bad-1', 'wrong dates')).ok).toBe(true);
    await h.host.close();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(join(h.config.directory, 'staged.sqlite' + suffix), { force: true });
      rmSync(join(h.config.directory, 'queue', 'shadow.sqlite' + suffix), { force: true });
    }
    copyFileSync(join(snapshot, 'staged.sqlite'), join(h.config.directory, 'staged.sqlite'));
    copyFileSync(
      join(snapshot, 'shadow.sqlite'),
      join(h.config.directory, 'queue', 'shadow.sqlite'),
    );
    const again = await makeHost({ root: h.root });
    await statusCommand(again.host);
    const gate = await again.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(/operator refusal/);
  });
});
