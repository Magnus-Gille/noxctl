/**
 * Encodes a user-supplied id as one URL path segment.
 *
 * `encodeURIComponent` leaves dots alone, and WHATWG URL parsing then collapses
 * dot segments: `inbox/.` becomes `/3/inbox/` and `inbox/..` becomes `/3/`. A `.`
 * or `..` id would therefore silently address the collection (or the API root)
 * instead of one record — and for a DELETE that is a different request than the
 * caller asked for. An empty id has the same effect through a trailing slash.
 * Reject all three before anything is sent; every other id is encoded exactly as
 * `encodeURIComponent` does, so `/` becomes `%2F` and stays inside its segment.
 */
export function pathSegment(name: string, value: string): string {
  if (value === '') {
    throw new Error(`Invalid ${name}: must not be empty`);
  }
  if (value === '.' || value === '..') {
    throw new Error(`Invalid ${name}: ${JSON.stringify(value)} would be read as a path, not an id`);
  }
  return encodeURIComponent(value);
}

function validateSegment(name: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return encodeURIComponent(value);
}

export function customerSegment(customerNumber: string): string {
  return validateSegment('customer number', customerNumber, /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/);
}

export function documentSegment(documentNumber: string): string {
  return validateSegment('document number', documentNumber, /^\d+$/);
}

export function voucherSeriesSegment(series: string): string {
  return validateSegment('voucher series', series, /^[A-Za-z0-9][A-Za-z0-9_-]{0,9}$/);
}
