import 'dotenv/config';
import { reconciliationService } from '@/lib/container';

// One-time historical ledger import from Stripe (paginated charges +
// invoices + refunds), so existing members see billing history from before
// the ledger existed. Ledger-only (never drives bookings settlement) and
// idempotent: re-running converges on the same rows.
//
//   npm run job:backfill-billing-ledger              # everything
//   BACKFILL_SINCE=2025-01-01 npm run job:backfill-billing-ledger

if (!process.env.STRIPE_SECRET_KEY?.trim()) {
  console.error('STRIPE_SECRET_KEY must be set to backfill the ledger');
  process.exit(1);
}

const sinceRaw = process.env.BACKFILL_SINCE?.trim();
const since = sinceRaw ? new Date(sinceRaw) : new Date(0);
if (Number.isNaN(since.getTime())) {
  console.error(`BACKFILL_SINCE is not a date: ${sinceRaw}`);
  process.exit(1);
}

const result = await reconciliationService.backfillLedger(since);

console.log(
  JSON.stringify({
    job: 'backfill-billing-ledger',
    since: since.toISOString(),
    ...result,
  }),
);
