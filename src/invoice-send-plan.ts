/**
 * Shared, side-effect-free logic for sending a customer invoice through
 * noxctl: which email fields the send will use (and where each came from),
 * and a reviewable preview of the whole send. Used by both the CLI and the
 * MCP tool so the two cannot drift apart.
 *
 * Scope: this only covers sends made through noxctl. Sends made in the Fortnox
 * web UI use Fortnox's own settings and are unaffected.
 */

export type InvoiceSendMethod = 'email' | 'print' | 'einvoice';

export interface InvoiceSendOptions {
  /** Subject for this invoice only. */
  subject?: string;
  /** Body for this invoice only. */
  body?: string;
  /** Explicit BCC for this invoice; overrides the invoice and the profile default. */
  bcc?: string;
  /** Send without any BCC: skips the profile default and clears one already on the invoice. */
  noBcc?: boolean;
  /** The resolved profile's default BCC, applied only to email sends without a BCC. */
  defaultBcc?: string;
}

export type BccSource = 'explicit' | 'invoice' | 'profile' | 'removed' | 'none';
export type TextSource = 'explicit' | 'invoice' | 'fortnox-default';

export interface ResolvedInvoiceEmail {
  from: string;
  to: string;
  cc: string;
  bcc: { value: string; source: BccSource; previous?: string };
  subject: { value: string; source: TextSource };
  body: { value: string; source: TextSource };
  /**
   * The EmailInformation object to write before sending, or null when the
   * invoice already holds exactly what will be sent.
   */
  update: Record<string, unknown> | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function resolveInvoiceEmail(
  existing: Record<string, unknown> | undefined,
  options: InvoiceSendOptions,
  method: InvoiceSendMethod,
): ResolvedInvoiceEmail {
  const current = existing ?? {};
  if (options.bcc && options.noBcc) {
    throw new Error('Give either an explicit BCC or no-BCC, not both.');
  }

  const changes: Record<string, string> = {};
  const currentBcc = str(current.EmailAddressBCC);

  let bcc: ResolvedInvoiceEmail['bcc'];
  if (options.bcc) {
    bcc = { value: options.bcc, source: 'explicit' };
    if (options.bcc !== currentBcc) changes.EmailAddressBCC = options.bcc;
  } else if (options.noBcc) {
    if (currentBcc) {
      bcc = { value: '', source: 'removed', previous: currentBcc };
      changes.EmailAddressBCC = '';
    } else {
      bcc = { value: '', source: 'none' };
    }
  } else if (currentBcc) {
    // An address already on the invoice (often copied from the customer card)
    // is never replaced by the profile default.
    bcc = { value: currentBcc, source: 'invoice' };
  } else if (method === 'email' && options.defaultBcc) {
    bcc = { value: options.defaultBcc, source: 'profile' };
    changes.EmailAddressBCC = options.defaultBcc;
  } else {
    bcc = { value: '', source: 'none' };
  }

  function text(key: 'EmailSubject' | 'EmailBody', explicit: string | undefined) {
    const now = str(current[key]);
    if (explicit) {
      if (explicit !== now) changes[key] = explicit;
      return { value: explicit, source: 'explicit' as const };
    }
    return now
      ? { value: now, source: 'invoice' as const }
      : { value: '', source: 'fortnox-default' as const };
  }

  const subject = text('EmailSubject', options.subject);
  const body = text('EmailBody', options.body);

  return {
    from: str(current.EmailAddressFrom),
    to: str(current.EmailAddressTo),
    cc: str(current.EmailAddressCC),
    bcc,
    subject,
    body,
    update: Object.keys(changes).length > 0 ? { ...current, ...changes } : null,
  };
}

/** A lookup that may have failed; the preview reports the reason instead of guessing. */
export type Lookup<T> = T | { unavailable: string } | null;

function isUnavailable(value: unknown): value is { unavailable: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { unavailable?: unknown }).unavailable === 'string'
  );
}

export interface InvoiceSendPlanInput {
  invoice: Record<string, unknown>;
  customer: Lookup<Record<string, unknown>>;
  attachments: Lookup<Record<string, unknown>[]>;
  method: InvoiceSendMethod;
  options: InvoiceSendOptions;
  /** Profile whose defaults were used, for display only. */
  profile?: string;
}

export interface InvoiceSendPlan {
  documentNumber: string;
  method: InvoiceSendMethod;
  delivery: string;
  profile?: string;
  customer: { number: string; name: string; defaultDeliveryType: string | null };
  status: {
    sent: boolean | null;
    /** Delivered through Fortnox Finans/Fakturaservice; `sent` stays false for those. */
    noxFinans: boolean;
    booked: boolean | null;
    cancelled: boolean | null;
    total: unknown;
    balance: unknown;
    currency: string;
    dueDate: string;
  };
  email: Omit<ResolvedInvoiceEmail, 'update'> | null;
  attachments: { invoicePdf: boolean; files: { fileId: string; name?: string }[] | null };
  emailInformationUpdate: Record<string, unknown> | null;
  warnings: string[];
  unavailable: string[];
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

const DELIVERY: Record<InvoiceSendMethod, string> = {
  email: 'Email from Fortnox with the invoice PDF attached',
  einvoice: 'E-invoice via Fortnox (no email is sent by noxctl)',
  print: 'Marked as sent/printed in Fortnox (no email is sent)',
};

const EXPECTED_DELIVERY_TYPE: Record<InvoiceSendMethod, string> = {
  email: 'EMAIL',
  einvoice: 'ELECTRONICINVOICE',
  print: 'PRINT',
};

export function buildInvoiceSendPlan(input: InvoiceSendPlanInput): InvoiceSendPlan {
  const { invoice, method } = input;
  const warnings: string[] = [];
  const unavailable: string[] = [];

  const resolved = resolveInvoiceEmail(
    invoice.EmailInformation as Record<string, unknown> | undefined,
    input.options,
    method,
  );
  const { update, ...email } = resolved;

  let defaultDeliveryType: string | null = null;
  if (isUnavailable(input.customer)) {
    unavailable.push(`Customer card: ${input.customer.unavailable}`);
  } else if (input.customer) {
    const types = input.customer.DefaultDeliveryTypes as Record<string, unknown> | undefined;
    defaultDeliveryType = str(types?.Invoice) || null;
  }

  let files: { fileId: string; name?: string }[] | null = null;
  if (isUnavailable(input.attachments)) {
    unavailable.push(`Attachments: ${input.attachments.unavailable}`);
  } else if (input.attachments && !Array.isArray(input.attachments)) {
    unavailable.push('Attachments: unexpected response from Fortnox');
  } else if (input.attachments) {
    files = input.attachments
      .filter((a) => a.includeOnSend === true)
      .map((a) => {
        const name = str(a.fileName) || str(a.name);
        return name ? { fileId: str(a.fileId), name } : { fileId: str(a.fileId) };
      });
  }

  const status = {
    sent: bool(invoice.Sent),
    noxFinans: invoice.NoxFinans === true,
    booked: bool(invoice.Booked),
    cancelled: bool(invoice.Cancelled),
    total: invoice.Total,
    balance: invoice.Balance,
    currency: str(invoice.Currency),
    dueDate: str(invoice.DueDate),
  };

  if (status.cancelled) warnings.push('The invoice is cancelled.');
  if (status.sent) warnings.push('The invoice is already marked as sent; this sends it again.');
  if (status.noxFinans) {
    warnings.push(
      'The invoice is handled by Fortnox Finans (NoxFinans). Fortnox keeps Sent false for these even after Fortnox Finans has sent it; check `noxctl noxfinans get` / fortnox_get_noxfinans_invoice before sending it again.',
    );
  }
  if (method === 'email' && !email.to) {
    warnings.push('No recipient (To) on the invoice; Fortnox has no address to email it to.');
  }
  if (defaultDeliveryType && defaultDeliveryType.toUpperCase() !== EXPECTED_DELIVERY_TYPE[method]) {
    warnings.push(
      `The customer's default delivery type is ${defaultDeliveryType}, but this sends via ${method}.`,
    );
  }

  return {
    documentNumber: str(invoice.DocumentNumber) || String(invoice.DocumentNumber ?? ''),
    method,
    delivery: DELIVERY[method],
    ...(input.profile ? { profile: input.profile } : {}),
    customer: {
      number: str(invoice.CustomerNumber),
      name: str(invoice.CustomerName),
      defaultDeliveryType,
    },
    status,
    email: method === 'email' ? email : null,
    attachments: { invoicePdf: method === 'email', files },
    emailInformationUpdate: update,
    warnings,
    unavailable,
  };
}

const BCC_SOURCE_LABEL: Record<BccSource, string> = {
  explicit: 'given for this send',
  invoice: 'already on the invoice',
  profile: 'profile default',
  removed: 'removed for this send',
  none: '',
};

const TEXT_SOURCE_LABEL: Record<TextSource, string> = {
  explicit: 'given for this send, this invoice only',
  invoice: 'already on the invoice',
  'fortnox-default': "Fortnox's default template",
};

function yesNo(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'yes' : 'no';
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : `               ${line}`))
    .join('\n');
}

export function formatInvoiceSendPlan(plan: InvoiceSendPlan): string {
  const lines: string[] = [];
  lines.push(`Send preview for invoice ${plan.documentNumber}`);
  lines.push(
    `  Customer:    ${[plan.customer.number, plan.customer.name].filter(Boolean).join(' ') || '(unknown)'}`,
  );
  const amounts = [
    plan.status.total !== undefined ? `total ${String(plan.status.total)}` : '',
    plan.status.balance !== undefined ? `balance ${String(plan.status.balance)}` : '',
    plan.status.currency,
    plan.status.dueDate ? `due ${plan.status.dueDate}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  lines.push(
    `  Status:      sent ${plan.status.noxFinans && plan.status.sent !== true ? 'via Fortnox Finans (see Finans status)' : yesNo(plan.status.sent)}, booked ${yesNo(plan.status.booked)}, cancelled ${yesNo(plan.status.cancelled)}${amounts ? ` · ${amounts}` : ''}`,
  );
  lines.push(`  Delivery:    ${plan.delivery}`);
  if (plan.customer.defaultDeliveryType) {
    lines.push(`  Customer default delivery: ${plan.customer.defaultDeliveryType}`);
  }

  if (plan.email) {
    const e = plan.email;
    if (e.from) lines.push(`  From:        ${e.from}`);
    lines.push(`  To:          ${e.to || '(none)'}`);
    lines.push(`  CC:          ${e.cc || '(none)'}`);
    let bcc = e.bcc.value || '(none)';
    if (e.bcc.source === 'profile') {
      bcc += `  [profile default${plan.profile ? ` "${plan.profile}"` : ''}]`;
    } else if (e.bcc.source === 'removed') {
      bcc += `  [${BCC_SOURCE_LABEL.removed}; was ${e.bcc.previous}]`;
    } else if (BCC_SOURCE_LABEL[e.bcc.source]) {
      bcc += `  [${BCC_SOURCE_LABEL[e.bcc.source]}]`;
    }
    lines.push(`  BCC:         ${bcc}`);
    lines.push(
      `  Subject:     ${e.subject.value || '(empty)'}  [${TEXT_SOURCE_LABEL[e.subject.source]}]`,
    );
    lines.push(
      `  Body:        ${e.body.value ? indent(e.body.value) : '(empty)'}  [${TEXT_SOURCE_LABEL[e.body.source]}]`,
    );
  } else {
    lines.push('  Email:       no email is sent by noxctl for this method');
  }

  const att: string[] = [];
  if (plan.attachments.invoicePdf) att.push('invoice PDF');
  if (plan.attachments.files === null) {
    att.push('extra files: unavailable');
  } else if (plan.attachments.files.length > 0) {
    att.push(
      `${plan.attachments.files.length} extra file(s) included on send: ${plan.attachments.files
        .map((f) => f.name ?? f.fileId)
        .join(', ')}`,
    );
  } else {
    att.push('no extra files');
  }
  lines.push(`  Attachments: ${att.join('; ')}`);

  if (plan.emailInformationUpdate) {
    lines.push('');
    lines.push('Before sending, the invoice email settings are updated to:');
    lines.push(
      JSON.stringify({ Invoice: { EmailInformation: plan.emailInformationUpdate } }, null, 2),
    );
  }
  if (plan.unavailable.length > 0) {
    lines.push('');
    lines.push('Unavailable (could not be read):');
    for (const u of plan.unavailable) lines.push(`  - ${u}`);
  }
  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of plan.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}
