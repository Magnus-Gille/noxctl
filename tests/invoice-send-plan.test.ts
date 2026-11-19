import { describe, it, expect } from 'vitest';
import {
  buildInvoiceSendPlan,
  formatInvoiceSendPlan,
  resolveInvoiceEmail,
} from '../src/invoice-send-plan.js';

const baseEmail = {
  EmailAddressFrom: 'billing@seller.example',
  EmailAddressTo: 'ap@customer.example',
  EmailAddressCC: '',
  EmailAddressBCC: '',
  EmailSubject: 'Faktura {no}',
  EmailBody: 'Hej!',
};

describe('resolveInvoiceEmail — BCC precedence', () => {
  it('applies the profile default when the invoice has no BCC', () => {
    const r = resolveInvoiceEmail(baseEmail, { defaultBcc: 'me@seller.example' }, 'email');
    expect(r.bcc).toEqual({ value: 'me@seller.example', source: 'profile' });
    expect(r.update).toMatchObject({ EmailAddressBCC: 'me@seller.example' });
  });

  it('keeps a BCC already on the invoice rather than overwriting it with the profile default', () => {
    const r = resolveInvoiceEmail(
      { ...baseEmail, EmailAddressBCC: 'existing@seller.example' },
      { defaultBcc: 'me@seller.example' },
      'email',
    );
    expect(r.bcc).toEqual({ value: 'existing@seller.example', source: 'invoice' });
    expect(r.update).toBeNull();
  });

  it('lets an explicit BCC override both the invoice and the profile default', () => {
    const r = resolveInvoiceEmail(
      { ...baseEmail, EmailAddressBCC: 'existing@seller.example' },
      { bcc: 'explicit@seller.example', defaultBcc: 'me@seller.example' },
      'email',
    );
    expect(r.bcc).toEqual({ value: 'explicit@seller.example', source: 'explicit' });
    expect(r.update).toMatchObject({ EmailAddressBCC: 'explicit@seller.example' });
  });

  it('noBcc suppresses the profile default', () => {
    const r = resolveInvoiceEmail(baseEmail, { noBcc: true, defaultBcc: 'me@x.example' }, 'email');
    expect(r.bcc).toEqual({ value: '', source: 'none' });
    expect(r.update).toBeNull();
  });

  it('noBcc removes a BCC already on the invoice, and says so', () => {
    const r = resolveInvoiceEmail(
      { ...baseEmail, EmailAddressBCC: 'existing@seller.example' },
      { noBcc: true },
      'email',
    );
    expect(r.bcc).toEqual({ value: '', source: 'removed', previous: 'existing@seller.example' });
    expect(r.update).toMatchObject({ EmailAddressBCC: '' });
  });

  it('refuses an explicit BCC combined with noBcc', () => {
    expect(() => resolveInvoiceEmail(baseEmail, { bcc: 'a@b.se', noBcc: true }, 'email')).toThrow(
      /bcc/i,
    );
  });

  it('does not apply the profile default for print or e-invoice', () => {
    for (const method of ['print', 'einvoice'] as const) {
      const r = resolveInvoiceEmail(baseEmail, { defaultBcc: 'me@seller.example' }, method);
      expect(r.bcc.source).toBe('none');
      expect(r.update).toBeNull();
    }
  });

  it('does not write anything when the explicit BCC equals what is already there', () => {
    const r = resolveInvoiceEmail(
      { ...baseEmail, EmailAddressBCC: 'same@seller.example' },
      { bcc: 'same@seller.example' },
      'email',
    );
    expect(r.update).toBeNull();
  });
});

describe('resolveInvoiceEmail — subject and body', () => {
  it('uses explicit subject/body only for this invoice and reports their source', () => {
    const r = resolveInvoiceEmail(baseEmail, { subject: 'Special', body: 'Text' }, 'email');
    expect(r.subject).toEqual({ value: 'Special', source: 'explicit' });
    expect(r.body).toEqual({ value: 'Text', source: 'explicit' });
    expect(r.update).toMatchObject({ EmailSubject: 'Special', EmailBody: 'Text' });
  });

  it('reports the invoice values when nothing is given', () => {
    const r = resolveInvoiceEmail(baseEmail, {}, 'email');
    expect(r.subject).toEqual({ value: 'Faktura {no}', source: 'invoice' });
    expect(r.body).toEqual({ value: 'Hej!', source: 'invoice' });
    expect(r.update).toBeNull();
  });

  it('marks empty subject/body as the Fortnox default template', () => {
    const r = resolveInvoiceEmail({ ...baseEmail, EmailSubject: '', EmailBody: '' }, {}, 'email');
    expect(r.subject.source).toBe('fortnox-default');
    expect(r.body.source).toBe('fortnox-default');
  });

  it('preserves the other EmailInformation fields in the update', () => {
    const r = resolveInvoiceEmail(baseEmail, { subject: 'New' }, 'email');
    expect(r.update).toEqual({ ...baseEmail, EmailSubject: 'New' });
  });
});

describe('buildInvoiceSendPlan', () => {
  const invoice = {
    DocumentNumber: '1001',
    CustomerNumber: '25',
    CustomerName: 'Kund AB',
    Sent: false,
    Booked: true,
    Cancelled: false,
    Total: 1250,
    Balance: 1250,
    Currency: 'SEK',
    DueDate: '2026-12-01',
    EmailInformation: baseEmail,
  };

  it('collects everything a reviewer needs before an email send', () => {
    const plan = buildInvoiceSendPlan({
      invoice,
      customer: { DefaultDeliveryTypes: { Invoice: 'EMAIL' } },
      attachments: [
        { fileId: 'f1', includeOnSend: true },
        { fileId: 'f2', includeOnSend: false },
      ],
      method: 'email',
      options: { defaultBcc: 'me@seller.example' },
      profile: 'work',
    });
    expect(plan.documentNumber).toBe('1001');
    expect(plan.customer).toMatchObject({ number: '25', name: 'Kund AB' });
    expect(plan.status).toMatchObject({ sent: false, booked: true, cancelled: false });
    expect(plan.email?.to).toBe('ap@customer.example');
    expect(plan.email?.bcc).toEqual({ value: 'me@seller.example', source: 'profile' });
    expect(plan.attachments).toEqual({ invoicePdf: true, files: [{ fileId: 'f1' }] });
    expect(plan.emailInformationUpdate).toMatchObject({ EmailAddressBCC: 'me@seller.example' });
    expect(plan.unavailable).toEqual([]);
    expect(plan.warnings).toEqual([]);

    const text = formatInvoiceSendPlan(plan);
    expect(text).toContain('1001');
    expect(text).toContain('Kund AB');
    expect(text).toContain('ap@customer.example');
    expect(text).toContain('me@seller.example');
    expect(text).toMatch(/profile default.*work/i);
    expect(text).toContain('Faktura {no}');
    expect(text).toContain('Hej!');
  });

  it('warns about an already-sent, cancelled invoice and a missing recipient', () => {
    const plan = buildInvoiceSendPlan({
      invoice: {
        ...invoice,
        Sent: true,
        Cancelled: true,
        EmailInformation: { ...baseEmail, EmailAddressTo: '' },
      },
      customer: { DefaultDeliveryTypes: { Invoice: 'PRINT' } },
      attachments: [],
      method: 'email',
      options: {},
    });
    const all = plan.warnings.join('\n');
    expect(all).toMatch(/already.*sent/i);
    expect(all).toMatch(/cancelled/i);
    expect(all).toMatch(/recipient/i);
    expect(all).toMatch(/PRINT/);
  });

  it('marks customer and attachment details as unavailable instead of guessing', () => {
    const plan = buildInvoiceSendPlan({
      invoice,
      customer: { unavailable: 'missing scope' },
      attachments: { unavailable: 'forbidden' },
      method: 'email',
      options: {},
    });
    expect(plan.unavailable.join('\n')).toMatch(/customer.*missing scope/i);
    expect(plan.unavailable.join('\n')).toMatch(/attachments.*forbidden/i);
    expect(plan.attachments.files).toBeNull();
    expect(formatInvoiceSendPlan(plan)).toMatch(/unavailable/i);
  });

  it('has no email section for print, and says nothing will be emailed', () => {
    const plan = buildInvoiceSendPlan({
      invoice,
      customer: null,
      attachments: [],
      method: 'print',
      options: { defaultBcc: 'me@seller.example' },
    });
    expect(plan.email).toBeNull();
    expect(plan.emailInformationUpdate).toBeNull();
    expect(formatInvoiceSendPlan(plan)).toMatch(/no email/i);
  });
});
