import { describe, expect, it } from 'vitest';
import { pathSegment } from '../src/identifiers.js';

describe('pathSegment', () => {
  it.each([
    ['inbox_v', 'inbox_v'],
    ['a/b', 'a%2Fb'],
    ['a b', 'a%20b'],
    ['a/b c', 'a%2Fb%20c'],
    ['ÅÄÖ', '%C3%85%C3%84%C3%96'],
    ['a?b#c', 'a%3Fb%23c'],
  ])('encodes %j exactly like encodeURIComponent', (id, expected) => {
    expect(pathSegment('id', id)).toBe(expected);
    expect(pathSegment('id', id)).toBe(encodeURIComponent(id));
  });

  it.each(['...', '.hidden', 'a.b', '1.5', 'file.pdf', ' . '])(
    'keeps %j, which URL parsing does not treat as a dot segment',
    (id) => {
      expect(pathSegment('id', id)).toBe(encodeURIComponent(id));
    },
  );

  it('double-encodes a literal %2e so it can never decode into a dot segment', () => {
    expect(pathSegment('id', '%2e')).toBe('%252e');
    expect(pathSegment('id', '%2E%2E')).toBe('%252E%252E');
  });

  it.each(['.', '..'])('rejects %j, which URL parsing collapses', (id) => {
    expect(() => pathSegment('article number', id)).toThrow(/Invalid article number/);
    expect(() => pathSegment('article number', id)).toThrow(JSON.stringify(id));
  });

  it('rejects an empty id, which would address the collection root', () => {
    expect(() => pathSegment('article number', '')).toThrow(
      'Invalid article number: must not be empty',
    );
  });
});
