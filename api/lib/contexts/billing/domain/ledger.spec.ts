import { monthKey, monthRangeUtc, monthTotals, type LedgerRowForTotals } from './ledger';

const NY = 'America/New_York';

function row(overrides: Partial<LedgerRowForTotals> = {}): LedgerRowForTotals {
  return {
    direction: 'debit',
    amountCents: 1000,
    status: 'succeeded',
    occurredAt: new Date('2026-06-15T18:00:00Z'),
    ...overrides,
  };
}

describe('monthKey', () => {
  it('groups by the venue wall clock, not UTC', () => {
    // Jan 31 8pm ET is Feb 1 01:00 UTC; it files under January.
    expect(monthKey(new Date('2026-02-01T01:00:00Z'), NY)).toBe('2026-01');
    // And a Jan 1 00:30 ET charge stays in January.
    expect(monthKey(new Date('2026-01-01T05:30:00Z'), NY)).toBe('2026-01');
  });
});

describe('monthRangeUtc', () => {
  it('covers exactly the venue-local month, DST-aware', () => {
    const { from, to } = monthRangeUtc('2026-03', NY);
    expect(from.toISOString()).toBe('2026-03-01T05:00:00.000Z'); // EST midnight
    expect(to.toISOString()).toBe('2026-04-01T04:00:00.000Z'); // EDT midnight
  });

  it('rolls the year over for December', () => {
    const { from, to } = monthRangeUtc('2026-12', NY);
    expect(from.toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(to.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });
});

describe('monthTotals', () => {
  it('buckets debits and credits per venue-local month, newest first', () => {
    const rows = [
      row({ amountCents: 2000, occurredAt: new Date('2026-05-10T12:00:00Z') }),
      row({ amountCents: 500, direction: 'credit', occurredAt: new Date('2026-05-11T12:00:00Z') }),
      row({ amountCents: 4800, occurredAt: new Date('2026-06-02T12:00:00Z') }),
    ];
    expect(monthTotals(rows, NY)).toEqual([
      { month: '2026-06', debitCents: 4800, creditCents: 0, netCents: 4800, count: 1 },
      { month: '2026-05', debitCents: 2000, creditCents: 500, netCents: 1500, count: 2 },
    ]);
  });

  it('files the UTC-boundary charge into the venue month', () => {
    const rows = [row({ occurredAt: new Date('2026-02-01T01:00:00Z') })]; // Jan 31 8pm ET
    expect(monthTotals(rows, NY)[0].month).toBe('2026-01');
  });

  it('counts pending rows (money committed) but never failed or canceled', () => {
    const rows = [
      row({ status: 'pending', direction: 'credit', amountCents: 700 }),
      row({ status: 'failed', amountCents: 9999 }),
      row({ status: 'canceled', amountCents: 9999 }),
      row({ amountCents: 1000 }),
    ];
    expect(monthTotals(rows, NY)).toEqual([
      { month: '2026-06', debitCents: 1000, creditCents: 700, netCents: 300, count: 2 },
    ]);
  });

  it('returns an empty list for an empty ledger', () => {
    expect(monthTotals([], NY)).toEqual([]);
  });
});
