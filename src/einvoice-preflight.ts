/** Conservative observations from supported invoice/customer reads, never a send probe. */
export function assessEinvoiceDraft(
  documentNumber: string,
  invoice: Record<string, unknown>,
  customer: Record<string, unknown> | null,
) {
  const stringValue = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value : null;
  const booleanValue = (value: unknown): boolean | null =>
    typeof value === 'boolean' ? value : null;
  const sent = booleanValue(invoice.Sent);
  const booked = booleanValue(invoice.Booked);
  const cancelled = booleanValue(invoice.Cancelled);
  const issues: Array<{
    code: string;
    severity: 'blocker' | 'unknown' | 'warning';
    message: string;
  }> = [];
  for (const [flag, value] of [
    ['sent', sent],
    ['booked', booked],
    ['cancelled', cancelled],
  ] as const) {
    if (value === true)
      issues.push({
        code: `invoice_${flag}`,
        severity: 'blocker',
        message: `Invoice is ${flag}; this check is for unsent, unbooked drafts.`,
      });
    if (value === null)
      issues.push({
        code: `invoice_${flag}_unknown`,
        severity: 'unknown',
        message: `Invoice ${flag} state was not returned as a boolean.`,
      });
  }
  if (!customer)
    issues.push({
      code: 'customer_missing',
      severity: 'blocker',
      message: 'Invoice has no customer number to read back.',
    });
  const edi =
    invoice.EDIInformation &&
    typeof invoice.EDIInformation === 'object' &&
    !Array.isArray(invoice.EDIInformation)
      ? (invoice.EDIInformation as Record<string, unknown>)
      : {};
  const reference = stringValue(invoice.YourReference);
  const electronicReference = stringValue(edi.EDIYourElectronicReference);
  if (!reference && !electronicReference)
    issues.push({
      code: 'reference_missing',
      severity: 'warning',
      message:
        'Neither buyer reference nor electronic reference is populated. Fortnox announces a required reference from 2026-10-19; recipients may already require one.',
    });
  issues.push(
    {
      code: 'recipient_connection_unsupported',
      severity: 'unknown',
      message:
        'No supported recipient discovery/connection-status interface is integrated. A GLN or customer delivery default does not verify an active connection.',
    },
    {
      code: 'peppol_address_unsupported',
      severity: 'unknown',
      message:
        'No supported Peppol address read/write interface is integrated; GLN is reported separately and is not proof of a persisted Peppol address.',
    },
    {
      code: 'effective_delivery_unknown',
      severity: 'unknown',
      message:
        'The customer default is an observation, not verification of this invoice’s persisted delivery route.',
    },
    {
      code: 'sender_verification_unknown',
      severity: 'unknown',
      message: 'Sender eligibility to send e-invoices has not been verified.',
    },
    {
      code: 'recipient_requirements_unknown',
      severity: 'unknown',
      message: 'Recipient-specific address and reference requirements have not been verified.',
    },
  );
  const defaults = customer?.DefaultDeliveryTypes;
  const deliveryDefault =
    defaults && typeof defaults === 'object' && !Array.isArray(defaults)
      ? stringValue((defaults as Record<string, unknown>).Invoice)
      : null;
  const blocked = issues.some((issue) => issue.severity === 'blocker');
  return {
    documentNumber,
    status: blocked ? ('blocked' as const) : ('unknown' as const),
    ready: false as const,
    readOnly: true as const,
    draft: {
      status:
        sent === false && booked === false && cancelled === false
          ? ('verified' as const)
          : blocked
            ? ('blocked' as const)
            : ('unknown' as const),
    },
    recipientConnection: {
      status: 'unsupported' as const,
      reasonCode: 'recipient_connection_unsupported',
    },
    peppolAddress: { status: 'unsupported' as const, reasonCode: 'peppol_address_unsupported' },
    effectiveDeliveryMethod: {
      status: 'unknown' as const,
      reasonCode: 'effective_delivery_unknown',
    },
    observed: {
      customerNumber: stringValue(invoice.CustomerNumber),
      sent,
      booked,
      cancelled,
      invoiceGLN: stringValue(edi.EDIGlobalLocationNumber),
      invoiceGLNDelivery: stringValue(edi.EDIGlobalLocationNumberDelivery),
      customerGLN: stringValue(customer?.GLN),
      customerDeliveryDefault: deliveryDefault,
      buyerReference: reference,
      electronicReference,
      ediStatus: stringValue(edi.EDIStatus),
    },
    issues,
  };
}
