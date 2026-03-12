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
