import { wallTimeToUtc, zonedDateKey } from '@/lib/kernel';
import type { TransactionDirection, TransactionStatus } from './transaction';

// The net-paid / refund-allocation math is the kernel's ONE shared
// implementation (lib/kernel/payment-allocation.ts); re-exported here so
// billing callers get it from their own domain barrel.
export {
  computeNetPaidCents,
  computeRefundableCents,
  allocateRefund,
  type RefundAllocation,
  type PaymentLike,
} from '@/lib/kernel';

export interface LedgerRowForTotals {
  direction: TransactionDirection;
  amountCents: number;
  status: TransactionStatus;
  occurredAt: Date;
}

export interface MonthBucket {
  /** "YYYY-MM" in the venue timezone. */
  month: string;
  debitCents: number;
  creditCents: number;
  /** debits minus credits; positive means the member paid on net. */
  netCents: number;
  count: number;
}

/**
 * The venue-local "YYYY-MM" a transaction files under. Grouping must happen
 * in the venue zone: a Jan 31 8pm ET charge is a January transaction even
 * though its UTC instant is Feb 1.
 */
export function monthKey(occurredAt: Date, timeZone: string): string {
  return zonedDateKey(occurredAt, timeZone).slice(0, 7);
}

/** UTC instant range covering a venue-local month (for range queries). */
export function monthRangeUtc(month: string, timeZone: string): { from: Date; to: Date } {
  const [year, monthNumber] = month.split('-').map(Number);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    from: wallTimeToUtc(`${year}-${pad(monthNumber)}-01`, 0, timeZone),
    to: wallTimeToUtc(`${nextYear}-${pad(nextMonth)}-01`, 0, timeZone),
  };
}

/**
 * Month buckets for the billing screen, newest first. Pending rows count
 * (money committed to move); failed and canceled rows do not.
 */
export function monthTotals(rows: LedgerRowForTotals[], timeZone: string): MonthBucket[] {
  const buckets = new Map<string, MonthBucket>();
  for (const row of rows) {
    if (row.status === 'failed' || row.status === 'canceled') continue;
    const month = monthKey(row.occurredAt, timeZone);
    let bucket = buckets.get(month);
    if (!bucket) {
      bucket = { month, debitCents: 0, creditCents: 0, netCents: 0, count: 0 };
      buckets.set(month, bucket);
    }
    if (row.direction === 'debit') bucket.debitCents += row.amountCents;
    else bucket.creditCents += row.amountCents;
    bucket.netCents = bucket.debitCents - bucket.creditCents;
    bucket.count += 1;
  }
  return [...buckets.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}
