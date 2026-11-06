import { isDeepStrictEqual } from 'node:util';
import type { AccountedRequestCallback, AccountedResponse } from './accounted-adapter.js';
import { resolveShadowIdentity } from './identity.js';
import { mapInvoiceDraft, type InvoiceDraftExpected } from './invoice-draft-mapping.js';
import { matchesInvoiceExpected } from './invoice-draft-adapter.js';
import { AccountedInvoiceStageVerifier } from './invoice-stage-verifier.js';
import { copy, digest, planPaymentQueue, restoreGroup } from './payment-queue-plan.js';
import {
  mapBookedInvoicePayment,
  type BookedPaymentPlan,
  type CapturedPaymentVoucher,
} from './payment-source-mapping.js';
import { verifyAccountedPaymentReadback } from './payment-readback.js';
import {
  TargetReceiptPendingError,
  type ShadowBinding,
  type ShadowPaymentAdapter,
  type ShadowPaymentGroup,
  type ShadowSnapshotEntry,
  type ShadowTargetReceipt,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InvoicePaymentPlan {
  version: 1;
  groupId: string;
  sourceCompany: string;
  targetCompany: string;
  targetInvoiceId: string;
  creatorIntentId: string;
  creatorRequestHash: string;
  prefixHash: string;
  expected: InvoiceDraftExpected;
  source: BookedPaymentPlan;
  body: { payment_date: string; lines: BookedPaymentPlan['lines'] };
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function data(value: unknown): Record<string, unknown> | undefined {
  return plain(value) && plain(value.data) ? value.data : undefined;
}
function emptyOptional(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || (Array.isArray(value[key]) && value[key].length === 0);
}
function cleanEnvelope(value: unknown): boolean {
  if (!plain(value) || !emptyOptional(value, 'warnings')) return false;
  if (!Object.hasOwn(value, 'meta')) return true;
  return (
    plain(value.meta) &&
    emptyOptional(value.meta, 'warnings') &&
    emptyOptional(value.meta, 'partial_expansions')
  );
}
function paidDate(value: unknown, date: string): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Date.parse(value) === Date.parse(`${date}T12:00:00Z`)
  );
}
function settled(value: Record<string, unknown>, plan: InvoicePaymentPlan): boolean {
  return (
    value.id === plan.targetInvoiceId &&
    value.status === 'paid' &&
    value.total === plan.source.amount &&
    value.paid_amount === plan.source.amount &&
    value.remaining_amount === 0 &&
    paidDate(value.paid_at, plan.source.paymentDate) &&
    emptyOptional(value, 'warnings')
  );
}
function validMutation(response: AccountedResponse, plan: InvoicePaymentPlan): boolean {
  const value = data(response.json);
  const meta = plain(response.json) ? response.json.meta : undefined;
  return (
    response.status === 200 &&
    cleanEnvelope(response.json) &&
    !!value &&
    settled(value, plan) &&
    value.dry_run !== true &&
    (!plain(meta) || meta.dry_run !== true) &&
    typeof value.payment_id === 'string' &&
    UUID.test(value.payment_id) &&
    typeof value.journal_entry_id === 'string' &&
    UUID.test(value.journal_entry_id) &&
    new Set(
      [plan.targetInvoiceId, value.payment_id, value.journal_entry_id].map((id) =>
        id.toLowerCase(),
      ),
    ).size === 3
  );
}
function receipt(
  plan: InvoicePaymentPlan,
  paymentId: string,
  complete: boolean,
  mutation?: AccountedResponse,
) {
  return {
    version: 1,
    kind: 'invoice-payment',
    complete,
    groupId: plan.groupId,
    plan: copy(plan),
    data: { id: paymentId },
    ...(mutation ? { mutation: { status: mutation.status, response: copy(mutation.json) } } : {}),
  };
}

/** Unwired synthetic evaluation adapter. Callbacks confer no live authorization. */
export class AccountedInvoicePaymentAdapter implements ShadowPaymentAdapter {
  private readonly binding: Readonly<ShadowBinding>;
  constructor(
    binding: ShadowBinding,
    private readonly snapshot: () => readonly ShadowSnapshotEntry[],
    private readonly voucherLookup: (
      group: ShadowPaymentGroup,
    ) => CapturedPaymentVoucher | undefined,
    private readonly request: AccountedRequestCallback,
  ) {
    if (
      !binding ||
      typeof binding.sourceCompany !== 'string' ||
      !binding.sourceCompany.trim() ||
      typeof binding.targetCompany !== 'string' ||
      !UUID.test(binding.targetCompany)
    )
      throw new Error('Invalid invoice payment company binding');
    this.binding = Object.freeze({ ...binding });
  }

  private capture(): ShadowSnapshotEntry[] {
    const entries = copy(this.snapshot());
    if (!Array.isArray(entries)) throw new Error('Payment snapshot is not an array');
    let previous = 0;
    const seen = new Set<string>();
    for (const entry of entries) {
      if (
        !entry ||
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence <= previous ||
        !entry.record ||
        typeof entry.record.id !== 'string' ||
        !entry.record.id.trim() ||
        seen.has(entry.record.id) ||
        entry.record.sourceCompany !== this.binding.sourceCompany ||
        entry.record.targetCompany !== this.binding.targetCompany
      )
        throw new Error('Payment snapshot ordering or binding is invalid');
      previous = entry.sequence;
      seen.add(entry.record.id);
    }
    return entries;
  }

  private prefix(entries: ShadowSnapshotEntry[], group: ShadowPaymentGroup): ShadowSnapshotEntry[] {
    const ids = new Set(group.members.map((member) => member.record.id));
    const terminal = group.members[group.members.length - 1].sequence;
    return entries.filter((entry) => entry.sequence < terminal && !ids.has(entry.record.id));
  }

  prepare(raw: ShadowPaymentGroup): { request: InvoicePaymentPlan } | { blocked: string } {
    try {
      const group = copy(raw);
      const entries = this.capture();
      const memberId = group?.members?.[0]?.record?.id;
      const member = entries.find((entry) => entry.record.id === memberId);
      let actual: ShadowPaymentGroup;
      if (member?.record.paymentGroup)
        actual = restoreGroup(entries, this.binding, member.record.id);
      else {
        const selected = planPaymentQueue(entries, this.binding);
        if (selected.kind !== 'payment')
          return { blocked: 'Payment group is not eligible in the durable queue.' };
        actual = selected.group;
      }
      if (!isDeepStrictEqual(actual, group))
        return { blocked: 'Payment group differs from durable source evidence.' };
      const prefix = this.prefix(entries, group);
      const records = prefix.map((entry) => entry.record);
      const identity = resolveShadowIdentity(
        records,
        this.binding,
        'invoice',
        group.sourceInvoiceId,
      );
      if (identity.state !== 'ready')
        return { blocked: 'Payment invoice identity is not applied.' };
      const creator = records.find((record) => record.id === identity.intentId);
      if (!creator || creator.state !== 'applied' || creator.operation !== 'createInvoice')
        return { blocked: 'Payment requires an applied strict invoice creator.' };
      const mapped = mapInvoiceDraft(creator, this.binding, (kind, id) =>
        resolveShadowIdentity(records, this.binding, kind, id),
      );
      if ('blocked' in mapped) return mapped;
      const saved = creator.targetReceipt;
      if (
        mapped.sourceInvoiceId !== group.sourceInvoiceId ||
        creator.targetId !== identity.targetId ||
        !plain(saved) ||
        !plain(saved.data) ||
        saved.data.id !== identity.targetId ||
        saved.sourceInvoiceId !== group.sourceInvoiceId ||
        !isDeepStrictEqual(saved.expected, mapped.expected)
      )
        return { blocked: 'Payment invoice creator receipt differs from its source mapping.' };
      const captured = this.voucherLookup(copy(group));
      if (!captured) return { blocked: 'Payment source voucher has not been captured.' };
      const source = mapBookedInvoicePayment(group, this.binding, captured, mapped.expected);
      if ('blocked' in source) return source;
      const plan: InvoicePaymentPlan = {
        version: 1,
        groupId: group.id,
        ...this.binding,
        targetInvoiceId: identity.targetId,
        creatorIntentId: creator.id,
        creatorRequestHash: creator.requestHash,
        prefixHash: digest(prefix),
        expected: mapped.expected,
        source: source.request,
        body: { payment_date: source.request.paymentDate, lines: copy(source.request.lines) },
      };
      if (member?.record.paymentGroup && member.record.paymentGroup.requestHash !== digest(plan))
        return { blocked: 'Payment plan changed after durable group claim.' };
      return { request: copy(plan) };
    } catch (cause) {
      return {
        blocked: `Payment preparation failed (${cause instanceof Error ? cause.name : 'UnknownError'}).`,
      };
    }
  }

  private current(group: ShadowPaymentGroup, plan: unknown): InvoicePaymentPlan {
    const prepared = this.prepare(group);
    if ('blocked' in prepared || !isDeepStrictEqual(prepared.request, plan))
      throw new Error('Payment plan no longer matches the durable source evidence');
    return prepared.request;
  }

  private readback(plan: InvoicePaymentPlan, paymentId: string, journalId: string) {
    return verifyAccountedPaymentReadback(
      {
        companyId: plan.targetCompany,
        invoiceId: plan.targetInvoiceId,
        paymentId,
        journalId,
        paymentDate: plan.source.paymentDate,
        amount: plan.source.amount,
        currency: 'SEK',
        journalSourceType: 'invoice_paid',
        lines: plan.source.lines,
      },
      this.request,
    );
  }

  async apply(raw: ShadowPaymentGroup, prepared: unknown): Promise<ShadowTargetReceipt> {
    const group = copy(raw);
    const plan = this.current(group, copy(prepared));
    // A transport cannot turn a dispatched failure into the queue's safe-retry sentinel.
    const request: AccountedRequestCallback = async (input) => {
      try {
        return await this.request(copy(input));
      } catch (cause) {
        throw new Error('Accounted payment transport failed', { cause });
      }
    };
    const stage = await new AccountedInvoiceStageVerifier(
      this.binding,
      () => this.prefix(this.capture(), group),
      request,
    ).verify(plan.source.sourceInvoiceId);
    if (
      stage.state !== 'verified' ||
      stage.stage !== 'sent' ||
      stage.targetId !== plan.targetInvoiceId
    )
      throw new Error('Payment requires an exact verified sent invoice');
    this.current(group, plan);
    const issueReceipt = this.prefix(this.capture(), group).find(
      (entry) => entry.record.id === stage.intentId,
    )?.record.targetReceipt;
    const issued =
      plain(issueReceipt) && plain(issueReceipt.mutation)
        ? issueReceipt.mutation.response
        : undefined;
    const invoiceNumber = plain(issued) ? issued.invoice_number : undefined;
    if (typeof invoiceNumber !== 'string' || !invoiceNumber.trim())
      throw new Error('Payment has no persisted issued invoice number');
    const path = `/api/v1/companies/${encodeURIComponent(plan.targetCompany)}/invoices/${encodeURIComponent(plan.targetInvoiceId)}`;
    const before = await request({ method: 'GET', path: `${path}?expand=items,payments` });
    const invoice = data(before.json);
    if (
      before.status !== 200 ||
      !cleanEnvelope(before.json) ||
      !invoice ||
      !matchesInvoiceExpected(before.json, plan.targetInvoiceId, plan.expected, {
        status: 'sent',
        invoiceNumber,
      }) ||
      !Array.isArray(invoice.payments) ||
      invoice.payments.length !== 0
    )
      throw new Error('Payment target invoice preflight differs from the expected unpaid invoice');
    const idempotencyKey = `shadow_payment_${digest(plan)}`;
    const dry = await request({
      method: 'POST',
      path: `${path}/mark-paid?dry_run=true`,
      body: plan.body,
      idempotencyKey: `${idempotencyKey}_preview`,
    });
    const previewEnvelope = data(dry.json);
    const preview = previewEnvelope?.preview;
    if (
      dry.status !== 200 ||
      !cleanEnvelope(dry.json) ||
      previewEnvelope?.dry_run !== true ||
      !plain(preview) ||
      !settled(preview, plan) ||
      preview.currency !== 'SEK' ||
      preview.invoice_number !== invoiceNumber ||
      preview.journal_entry_id !== null ||
      preview.accounting_method !== 'cash' ||
      preview.would_use_custom_lines !== true ||
      preview.would_create_journal_entry !== true ||
      Object.hasOwn(preview, 'payment_id')
    )
      throw new Error('Payment validation preview does not prove the expected cash settlement');
    this.current(group, plan);
    const response = await request({
      method: 'POST',
      path: `${path}/mark-paid`,
      body: plan.body,
      idempotencyKey,
    });
    const paymentId = data(response.json)?.payment_id;
    if (typeof paymentId !== 'string' || !UUID.test(paymentId))
      throw new Error('Payment mutation has no valid payment-row identity; do not retry');
    let saved: ReturnType<typeof receipt>;
    let detached: AccountedResponse;
    try {
      detached = copy(response);
      saved = receipt(plan, paymentId, validMutation(detached, plan), detached);
    } catch (cause) {
      throw new TargetReceiptPendingError(paymentId, receipt(plan, paymentId, false), { cause });
    }
    if (!saved.complete)
      throw new TargetReceiptPendingError(paymentId, saved, {
        cause: new Error('Payment mutation receipt is incomplete or contradictory'),
      });
    try {
      const journalId = data(detached.json)!.journal_entry_id as string;
      if (!(await this.readback(plan, paymentId, journalId)))
        throw new Error('Payment readback differs from the source');
      this.current(group, plan);
    } catch (cause) {
      throw new TargetReceiptPendingError(paymentId, saved, { cause });
    }
    return { targetId: paymentId, receipt: saved };
  }

  async verify(group: ShadowPaymentGroup, raw: ShadowTargetReceipt): Promise<boolean> {
    const prepared = this.prepare(group);
    if ('blocked' in prepared) return false;
    let saved: ShadowTargetReceipt;
    try {
      saved = copy(raw);
    } catch {
      return false;
    }
    const value = saved.receipt;
    if (
      !plain(value) ||
      value.complete !== true ||
      !plain(value.mutation) ||
      typeof value.mutation.status !== 'number'
    )
      return false;
    const response = { status: value.mutation.status, json: value.mutation.response };
    const plan = prepared.request;
    if (
      !validMutation(response, plan) ||
      data(response.json)?.payment_id !== saved.targetId ||
      !isDeepStrictEqual(value, receipt(plan, saved.targetId, true, response))
    )
      return false;
    if (
      !(await this.readback(plan, saved.targetId, data(response.json)!.journal_entry_id as string))
    )
      return false;
    const current = this.prepare(group);
    return 'request' in current && isDeepStrictEqual(current.request, plan);
  }
}
