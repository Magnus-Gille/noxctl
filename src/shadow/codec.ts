const MAX_ENCODED_BYTES = 32 * 1024 * 1024;

/** Tagged encoding avoids JSON's undefined/Buffer/type collisions in intent hashes. */
export function canonicalEncode(value: unknown): string {
  const seen = new Set<object>();
  function encode(v: unknown): unknown {
    if (v === undefined) return ['undefined'];
    if (v === null) return ['null'];
    if (typeof v === 'string' || typeof v === 'boolean') return [typeof v, v];
    if (typeof v === 'number' && Number.isFinite(v)) return ['number', Object.is(v, -0) ? '-0' : v];
    if (typeof v !== 'object' || v === null) throw new Error('Unsupported shadow payload type');
    if (seen.has(v)) throw new Error('Cyclic shadow payload');
    seen.add(v);
    try {
      if (Buffer.isBuffer(v)) return ['buffer', v.toString('base64')];
      if (Array.isArray(v)) return ['array', v.map(encode)];
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        throw new Error('Shadow payload requires plain objects');
      if (Object.getOwnPropertySymbols(v).length)
        throw new Error('Shadow payload cannot contain symbol keys');
      return [
        'object',
        Object.keys(v)
          .sort()
          .map((key) => [key, encode((v as Record<string, unknown>)[key])]),
      ];
    } finally {
      seen.delete(v);
    }
  }
  const text = JSON.stringify(encode(value));
  if (Buffer.byteLength(text) > MAX_ENCODED_BYTES) throw new Error('Shadow payload exceeds 32 MiB');
  return text;
}
export function decode(text: string): unknown {
  function visit(v: [string, unknown]): unknown {
    switch (v[0]) {
      case 'undefined':
        return undefined;
      case 'null':
        return null;
      case 'buffer':
        return Buffer.from(v[1] as string, 'base64');
      case 'array':
        return (v[1] as [string, unknown][]).map(visit);
      case 'object':
        return Object.fromEntries(
          (v[1] as [string, [string, unknown]][]).map(([k, val]) => [k, visit(val)]),
        );
      case 'number':
        return v[1] === '-0' ? -0 : v[1];
      case 'string':
      case 'boolean':
        return v[1];
      default:
        throw new Error('Invalid shadow payload encoding');
    }
  }
  return visit(JSON.parse(text));
}
