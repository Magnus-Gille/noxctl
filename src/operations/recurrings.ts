import { fortnoxRequest, fortnoxRequestWithMetadata } from '../fortnox-client.js';

const RECURRINGS = '/api/recurring-billing/recurrings-v1';
const INVOICE_REQUESTS = '/api/recurring-billing/recurrings-invoice-requests-v1';

export type Recurring = Record<string, unknown>;
export type InvoiceRequest = Record<string, unknown>;

export interface RecurringWithMetadata {
  recurring: Recurring;
  etag?: string;
  lastModified?: string;
}

export interface ListRecurringsParams {
  customerNumbers?: string[];
  statuses?: string[];
  invoiceHandlings?: string[];
  errorStatus?: string;
  offset?: number;
  limit?: number;
  sortBy?: string;
  order?: 'ASC' | 'DESC';
}

function uuidSegment(name: string, value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value;
}

function csv(values: string[] | undefined): string | undefined {
  return values?.join(',');
}

function metadata(result: {
  data: Recurring;
  etag?: string;
  lastModified?: string;
}): RecurringWithMetadata {
  return { recurring: result.data, etag: result.etag, lastModified: result.lastModified };
}

export async function listRecurrings(params: ListRecurringsParams = {}): Promise<Recurring[]> {
  return fortnoxRequest<Recurring[]>(RECURRINGS, {
    params: {
      'customer-numbers': csv(params.customerNumbers),
      statuses: csv(params.statuses),
      'invoice-handlings': csv(params.invoiceHandlings),
      'error-status': params.errorStatus,
      offset: params.offset,
      limit: params.limit,
      sortby: params.sortBy,
      order: params.order,
    },
  });
}

export async function getRecurring(recurringId: string): Promise<RecurringWithMetadata> {
  return metadata(
    await fortnoxRequestWithMetadata<Recurring>(
      `${RECURRINGS}/${uuidSegment('recurring ID', recurringId)}`,
    ),
  );
}

export async function createRecurring(input: Recurring): Promise<RecurringWithMetadata> {
  return metadata(
    await fortnoxRequestWithMetadata<Recurring>(RECURRINGS, { method: 'POST', body: input }),
  );
}

export async function replaceRecurring(
  recurringId: string,
  etag: string,
  input: Recurring,
  ifUnmodifiedSince?: string,
): Promise<RecurringWithMetadata> {
  return metadata(
    await fortnoxRequestWithMetadata<Recurring>(
      `${RECURRINGS}/${uuidSegment('recurring ID', recurringId)}`,
      {
        method: 'PUT',
        body: input,
        headers: { 'If-Match': etag, 'If-Unmodified-Since': ifUnmodifiedSince },
      },
    ),
  );
}

export async function patchRecurring(
  recurringId: string,
  etag: string,
  operations: Record<string, unknown>[],
  ifUnmodifiedSince?: string,
): Promise<RecurringWithMetadata> {
  return metadata(
    await fortnoxRequestWithMetadata<Recurring>(
      `${RECURRINGS}/${uuidSegment('recurring ID', recurringId)}`,
      {
        method: 'PATCH',
        body: operations,
        headers: { 'If-Match': etag, 'If-Unmodified-Since': ifUnmodifiedSince },
      },
    ),
  );
}

export async function listRecurringDeviations(recurringId: string): Promise<Recurring[]> {
  return fortnoxRequest<Recurring[]>(
    `${RECURRINGS}/${uuidSegment('recurring ID', recurringId)}/deviations`,
  );
}

export async function getRecurringDeviation(
  recurringId: string,
  deviationId: string,
): Promise<Recurring> {
  return fortnoxRequest<Recurring>(
    `${RECURRINGS}/${uuidSegment('recurring ID', recurringId)}/deviations/${uuidSegment('deviation ID', deviationId)}`,
  );
}

export async function listInvoiceRequests(
  recurringIds: string[],
  statuses?: string[],
): Promise<InvoiceRequest[]> {
  return fortnoxRequest<InvoiceRequest[]>(INVOICE_REQUESTS, {
    params: { 'recurring-ids': csv(recurringIds), status: csv(statuses) },
  });
}

export async function getInvoiceRequest(invoiceRequestId: string): Promise<InvoiceRequest> {
  return fortnoxRequest<InvoiceRequest>(
    `${INVOICE_REQUESTS}/${uuidSegment('invoice request ID', invoiceRequestId)}`,
  );
}

export async function createInvoiceRequest(
  recurringIds: string[],
  processingMode: 'SYNC' | 'ASYNC' = 'SYNC',
): Promise<InvoiceRequest> {
  if (recurringIds.length === 0) {
    throw new Error('At least one recurring ID is required.');
  }
  if (processingMode === 'SYNC' && recurringIds.length > 100) {
    throw new Error(
      'SYNC invoice requests support at most 100 recurring IDs. Use ASYNC for larger batches.',
    );
  }
  return fortnoxRequest<InvoiceRequest>(INVOICE_REQUESTS, {
    method: 'POST',
    params: { 'processing-mode': processingMode },
    body: { recurring_ids: recurringIds },
  });
}
