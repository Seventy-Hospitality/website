import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { BillingMonth, BillingOverview, BillingTransaction } from '../../lib/api';
import { formatAmount } from '../../lib/plan-pricing';
import { useVenueTimezone } from '../../lib/venue';
import { PageHeader } from '../../app/AppShell';
import { Button, Card, EmptyState, Skeleton } from '../../components';
import { membershipQuery } from '../onboarding/onboarding-data';
import {
  billingMonthLabel,
  billingMonthSummary,
  canCancelMembership,
  canChangeMembership,
  cardExpiryLabel,
  instantDateLabel,
  membershipStatusLine,
  transactionAmountLabel,
} from './account-lib';
import { billingTransactionsQuery } from './account-data';
import styles from './account.module.css';

const TXN_STATUS_LABELS: Record<BillingTransaction['status'], string | null> = {
  succeeded: null,
  pending: 'Pending',
  failed: 'Failed',
  canceled: 'Canceled',
};

/**
 * Billing (Figma billing 107:10434): the current membership (plan, status
 * line, price), the default payment method with Edit, the Change
 * membership row, and the ledger grouped by venue-local month, each month
 * an accessible disclosure whose transactions load lazily on first
 * expand. Two columns (membership | history) from 1024px.
 *
 * Reads ride W1's ['membership'] query: GET /api/me/billing serves both
 * onboarding gating and this page, so there is no second overview key.
 */
export function BillingPage() {
  const overview = useQuery(membershipQuery);

  if (overview.isPending) {
    return (
      <BillingFrame>
        <div role="status" aria-busy="true" className={styles.loadingStack}>
          <span className="visually-hidden">Loading your billing</span>
          <Skeleton height="10rem" shape="card" />
          <Skeleton height="4.5rem" shape="card" />
          <Skeleton height="4.5rem" shape="card" />
        </div>
      </BillingFrame>
    );
  }

  if (overview.isError) {
    return (
      <BillingFrame>
        <div className={styles.errorBox} role="alert">
          <p>We could not load your billing.</p>
          <Button variant="secondary" size="sm" onClick={() => void overview.refetch()}>
            Try again
          </Button>
        </div>
      </BillingFrame>
    );
  }

  return (
    <BillingFrame>
      <div className={styles.billingColumns}>
        <section className={styles.section} aria-labelledby="billing-membership-label">
          <h2 id="billing-membership-label" className={styles.sectionLabel}>
            Membership
          </h2>
          <MembershipCard overview={overview.data} />
        </section>

        <section className={styles.section} aria-labelledby="billing-history-label">
          <h2 id="billing-history-label" className={styles.sectionLabel}>
            Billing history
          </h2>
          {overview.data.months.length === 0 ? (
            <EmptyState
              icon={<CalendarDays aria-hidden />}
              title="No transactions yet"
              description="Your membership and booking payments will show up here."
            />
          ) : (
            <ul className={styles.historyList} aria-label="Billing history by month">
              {overview.data.months.map((month) => (
                <li key={month.month}>
                  <MonthDisclosure month={month} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </BillingFrame>
  );
}

function BillingFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <Link to="/account" className={styles.backLink}>
        <ChevronLeft aria-hidden />
        Back to account
      </Link>
      <PageHeader title="Billing" />
      {children}
    </div>
  );
}

function MembershipCard({ overview }: { overview: BillingOverview }) {
  const { membership, defaultPaymentMethod } = overview;
  // Status-line dates render on the venue's calendar, like the ledger.
  const timezone = useVenueTimezone();

  // Active memberships get the full change screen; a live-but-not-active
  // one (past_due, unpaid, paused, incomplete) still gets a cancel entry,
  // because the backend deliberately accepts a cancel in those states.
  const membershipAction = canChangeMembership(membership)
    ? 'Change membership'
    : canCancelMembership(membership)
      ? 'Cancel membership'
      : null;

  if (!membership) {
    return (
      <Card padding="lg">
        <p className={styles.dialogText}>You do not have a membership.</p>
        <p className={styles.dialogHint}>
          Contact the club if you would like to restart your membership.
        </p>
      </Card>
    );
  }

  return (
    <Card padding="none" className={styles.membershipCard}>
      <div className={styles.planRow}>
        <h3 className={styles.planName}>{membership.plan?.name ?? 'Membership'}</h3>
        {membership.plan && (
          <span className={styles.planPrice}>
            {formatAmount(membership.plan.amountCents)}
            {membership.plan.interval === 'year' ? '/yr' : '/mo'}
          </span>
        )}
      </div>
      <p className={styles.planStatus}>{membershipStatusLine(membership, timezone)}</p>

      <div className={styles.paymentRow}>
        {defaultPaymentMethod ? (
          <>
            <span className={styles.brandChip}>{defaultPaymentMethod.brand}</span>
            <span className={styles.paymentDetail}>
              •••• {defaultPaymentMethod.last4} · exp{' '}
              {cardExpiryLabel(defaultPaymentMethod.expMonth, defaultPaymentMethod.expYear)}
            </span>
            <Link to="/account/payment-method" className={styles.paymentEdit}>
              Edit<span className="visually-hidden"> payment method</span>
            </Link>
          </>
        ) : (
          <>
            <span className={styles.paymentDetail}>No payment method on file</span>
            <Link to="/account/payment-method" className={styles.paymentEdit}>
              Add<span className="visually-hidden"> payment method</span>
            </Link>
          </>
        )}
      </div>

      {membershipAction && (
        <Link to="/account/membership" className={[styles.menuRow, styles.menuRowAccent].join(' ')}>
          <span className={styles.menuRowLabel}>{membershipAction}</span>
          <ChevronRight aria-hidden className={styles.menuChevron} />
        </Link>
      )}
    </Card>
  );
}

/**
 * One ledger month as a disclosure: button with aria-expanded/controls,
 * transactions fetched on the FIRST expand only (kept after collapse).
 */
function MonthDisclosure({ month }: { month: BillingMonth }) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const regionId = useId();
  const buttonId = useId();

  const transactions = useQuery({
    ...billingTransactionsQuery(month.month),
    enabled: everOpened,
  });

  return (
    <Card padding="none">
      <button
        type="button"
        id={buttonId}
        className={styles.monthButton}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => {
          setOpen((prev) => !prev);
          setEverOpened(true);
        }}
      >
        <span className={styles.monthText}>
          <span className={styles.monthTitle}>{billingMonthLabel(month.month)}</span>
          <span className={styles.monthSummary}>
            {billingMonthSummary(month.count, month.netCents)}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={[styles.monthChevron, open ? styles.monthChevronOpen : ''].join(' ')}
        />
      </button>

      <div id={regionId} role="region" aria-labelledby={buttonId} hidden={!open}>
        {transactions.isPending && (
          <div className={styles.txnList} role="status" aria-busy="true">
            <span className="visually-hidden">Loading transactions</span>
            <div className={styles.txnRow}>
              <Skeleton height="2rem" />
            </div>
          </div>
        )}

        {transactions.isError && (
          <div className={styles.txnList}>
            <div className={styles.errorBox} role="alert">
              <p>We could not load this month.</p>
              <Button variant="secondary" size="sm" onClick={() => void transactions.refetch()}>
                Try again
              </Button>
            </div>
          </div>
        )}

        {transactions.isSuccess &&
          (transactions.data.transactions.length === 0 ? (
            <div className={styles.txnList}>
              <p className={styles.dialogHint}>No transactions this month.</p>
            </div>
          ) : (
            <ul className={styles.txnList} aria-label={`Transactions in ${billingMonthLabel(month.month)}`}>
              {transactions.data.transactions.map((txn) => (
                <TransactionRow key={txn.id} txn={txn} />
              ))}
            </ul>
          ))}
      </div>
    </Card>
  );
}

function TransactionRow({ txn }: { txn: BillingTransaction }) {
  const statusLabel = TXN_STATUS_LABELS[txn.status];
  const inactive = txn.status === 'failed' || txn.status === 'canceled';
  // The months are bucketed in the venue zone; the row date must render in
  // the same zone or a boundary row lands outside its month header.
  const timezone = useVenueTimezone();

  return (
    <li className={styles.txnRow}>
      <span className={styles.txnText}>
        <span className={[styles.txnDescription, inactive ? styles.txnMuted : ''].join(' ')}>
          {txn.description}
        </span>
        <span className={styles.txnMeta}>
          {instantDateLabel(txn.occurredAt, timezone)}
          {statusLabel && ` · ${statusLabel}`}
          {txn.receiptUrl && (
            <>
              {' · '}
              <a href={txn.receiptUrl} target="_blank" rel="noreferrer">
                Receipt
              </a>
            </>
          )}
        </span>
      </span>
      <span
        className={[
          styles.txnAmount,
          txn.direction === 'credit' && !inactive ? styles.txnAmountCredit : '',
          inactive ? styles.txnMuted : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {transactionAmountLabel(txn)}
      </span>
    </li>
  );
}
