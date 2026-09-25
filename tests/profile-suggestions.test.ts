import { describe, expect, it } from 'vitest';
import {
  formatMissingProfileGuidance,
  shouldShowProfileBanner,
  suggestProfileNames,
} from '../src/profile-suggestions.js';

describe('profile suggestions', () => {
  it('suggests close known names without treating them as a selection', () => {
    const suggestions = suggestProfileNames('defaukt', [{ name: 'default' }, { name: 'work' }]);
    expect(suggestions).toEqual(['default']);
  });

  it('recognizes adjacent transposition typos', () => {
    expect(suggestProfileNames('defualt', [{ name: 'default' }])).toEqual(['default']);
  });

  it('ignores malformed and invalid profile-index entries', () => {
    expect(
      suggestProfileNames('defaukt', [
        null,
        10,
        { name: '\u001b[31mdefault' },
        { name: 'default' },
      ]),
    ).toEqual(['default']);
  });

  it('keeps the profile list guidance ahead of creating a profile', () => {
    const guidance = formatMissingProfileGuidance('defaukt', [{ name: 'default' }]);
    expect(guidance).toContain('Did you mean "default"?');
    expect(guidance.indexOf('noxctl profile list')).toBeLessThan(
      guidance.indexOf('noxctl init --profile defaukt'),
    );
  });

  it('shows no false suggestion for a distant name', () => {
    const guidance = formatMissingProfileGuidance('vendor', [{ name: 'default' }]);
    expect(guidance).not.toContain('Did you mean');
    expect(guidance).toContain('noxctl profile list');
  });

  it('ranks closer names first and caps the suggestion list at three', () => {
    expect(
      suggestProfileNames('accounting', [{ name: 'aconting' }, { name: 'accouning' }]),
    ).toEqual(['accouning', 'aconting']);
    expect(
      suggestProfileNames('target', [
        { name: 'targez' },
        { name: 'targeta' },
        { name: 'targey' },
        { name: 'targex' },
      ]),
    ).toEqual(['targeta', 'targex', 'targey']);
  });
});

describe('profile use banner detection', () => {
  it('suppresses the old indicator for profile use but keeps it for other non-default actions', () => {
    expect(shouldShowProfileBanner('work', true, 'use', 'profile')).toBe(false);
    expect(shouldShowProfileBanner('work', true, 'use', 'invoices')).toBe(true);
    expect(shouldShowProfileBanner('work', true, 'list', 'invoices')).toBe(true);
    expect(shouldShowProfileBanner('default', true, 'list', 'invoices')).toBe(false);
    expect(shouldShowProfileBanner('work', false, 'list', 'invoices')).toBe(false);
  });
});
