import { describe, it, expect } from 'vitest';
import { SCOPES, grantedOptIns, initRerunCommand, optInSummary } from '../src/auth.js';

// NOX-231: `init` replaces the granted scope set with exactly what the flags
// request, so doctor/init must say which opt-ins a profile has and how to keep them.
describe('grantedOptIns', () => {
  it('returns nothing for the default scope set', () => {
    expect(grantedOptIns(SCOPES)).toEqual([]);
  });

  it('lists every opt-in group present, in flag order', () => {
    const scopes = `${SCOPES} offer order archive noxfinansinvoice`;
    expect(grantedOptIns(scopes).map((o) => o.flag)).toEqual([
      '--with-orders',
      '--with-archive',
      '--with-noxfinans',
    ]);
  });

  it('only counts orders when both offer and order are granted', () => {
    expect(grantedOptIns(`${SCOPES} order`)).toEqual([]);
  });

  it('names the Swedish developer portal permission', () => {
    const [noxfinans] = grantedOptIns(`${SCOPES} noxfinansinvoice`);
    expect(noxfinans!.portal).toContain('Faktura (Nox Finans)');
    const [salary] = grantedOptIns(`${SCOPES} salary`);
    expect(salary!.portal).toContain('Lön');
  });
});

describe('initRerunCommand', () => {
  it('builds a bare init line when there are no opt-ins', () => {
    expect(initRerunCommand(SCOPES)).toBe('noxctl init');
  });

  it('includes every granted opt-in flag', () => {
    expect(initRerunCommand(`${SCOPES} salary noxfinansinvoice`)).toBe(
      'noxctl init --with-salary --with-noxfinans',
    );
  });

  it('adds --profile for non-default profiles only', () => {
    expect(initRerunCommand(`${SCOPES} salary`, 'work')).toBe(
      'noxctl init --profile work --with-salary',
    );
    expect(initRerunCommand(`${SCOPES} salary`, 'default')).toBe('noxctl init --with-salary');
  });
});

describe('optInSummary', () => {
  it('says none and how to add one when no opt-ins are granted', () => {
    const s = optInSummary(SCOPES);
    expect(s).toMatch(/^none/);
    expect(s).toContain('--with-noxfinans');
  });

  it('lists granted opt-ins and the line that keeps them', () => {
    const s = optInSummary(`${SCOPES} offer order noxfinansinvoice`, 'work');
    expect(s).toContain('orders (offer, order)');
    expect(s).toContain('noxfinans (noxfinansinvoice)');
    expect(s).toContain('noxctl init --profile work --with-orders --with-noxfinans');
  });
});
