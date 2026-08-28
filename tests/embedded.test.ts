import { describe, expect, it } from 'vitest';
import { createServer } from '../src/embedded.js';

describe('embedded API', () => {
  it('fails closed when no tenant-bound transport is supplied', () => {
    expect(() => createServer(undefined as never)).toThrow(/tenant-bound transport/i);
    expect(() => createServer({} as never)).toThrow(/tenant-bound transport/i);
  });
});
