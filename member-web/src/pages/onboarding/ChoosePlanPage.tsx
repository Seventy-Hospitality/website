import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { plansQuery } from './onboarding-data';
import {
  billingCaption,
  defaultBillingPeriod,
  formatAmount,
  listBillingPeriods,
  periodSuffix,
  planCardsForPeriod,
  PERIOD_LABELS,
  type PlanCard,
} from '../../lib/plan-pricing';
import type { BillingInterval } from '../../lib/api';
import { useSession } from '../../lib/session-context';
import { Badge, Button, EmptyState, SegmentedControl, Skeleton } from '../../components';
import layout from './onboarding.module.css';
import styles from './ChoosePlanPage.module.css';

/**
 * Onboarding step 1 (Figma onboarding/choose-membership 68:1559): billing
 * period toggle, the Member plan card with price + feature bullets, the
 * invite-only Pro tier rendered locked, Continue to checkout.
 *
 * Cards are derived from whatever GET /api/plans returns: one card per
 * tier, re-priced per the selected period (src/lib/plan-pricing.ts).
 */
export function ChoosePlanPage() {
  const navigate = useNavigate();
  const { emailVerified, signOut } = useSession();
  const plans = useQuery(plansQuery);
  const [chosenPeriod, setChosenPeriod] = useState<BillingInterval | null>(null);
  const [chosenTier, setChosenTier] = useState<string | null>(null);
  const signOutMutation = useMutation({ mutationFn: signOut });

  const rows = plans.data ?? [];
  const periods = listBillingPeriods(rows);
  const period =
    chosenPeriod !== null && periods.includes(chosenPeriod)
      ? chosenPeriod
      : defaultBillingPeriod(rows);
  const cards = planCardsForPeriod(rows, period);
  const selectable = cards.filter((card) => !card.locked);
  const selected =
    selectable.find((card) => card.tier === chosenTier) ?? selectable[0] ?? null;

  return (
    <div className={layout.page}>
      <div className={layout.column}>
        <h1 className={layout.title}>Become a member</h1>

        {plans.isPending && (
          <div className={styles.loading} aria-busy="true" role="status">
            <span className="visually-hidden">Loading membership plans</span>
            <Skeleton height="2.5rem" shape="card" />
            <Skeleton height="21rem" shape="card" />
            <Skeleton height="5rem" shape="card" />
          </div>
        )}

        {plans.isError && (
          <div className={layout.errorBox} role="alert">
            <p>We could not load the membership plans.</p>
            <Button variant="secondary" size="sm" onClick={() => void plans.refetch()}>
              Try again
            </Button>
          </div>
        )}

        {plans.isSuccess && rows.length === 0 && (
          <EmptyState
            title="Memberships are not available yet"
            description="The club has not published its plans. Please check back soon."
            action={
              <Button variant="secondary" onClick={() => void plans.refetch()}>
                Try again
              </Button>
            }
          />
        )}

        {plans.isSuccess && rows.length > 0 && (
          <>
            {periods.length > 1 && (
              <SegmentedControl
                label="Billing period"
                options={periods.map((value) => ({ value, label: PERIOD_LABELS[value] }))}
                value={period}
                onChange={(value) => setChosenPeriod(value)}
              />
            )}

            <div className={styles.cards}>
              {cards.map((card) =>
                card.locked ? (
                  <LockedPlanCard key={card.tier} card={card} />
                ) : (
                  <SelectablePlanCard
                    key={card.tier}
                    card={card}
                    selected={selected?.tier === card.tier}
                    onSelect={() => setChosenTier(card.tier)}
                  />
                ),
              )}
            </div>

            <div className={layout.footer}>
              {/* The Figma's "Back to account details" returns to the signup
                  wizard step; on web the account already exists, so this slot
                  links to the account surfaces that DO exist mid-onboarding. */}
              {!emailVerified && (
                <button
                  type="button"
                  className={layout.footerLink}
                  onClick={() => navigate('/verify-email')}
                >
                  Back to account details
                </button>
              )}
              <Button
                fullWidth
                disabled={selected === null}
                onClick={() => {
                  if (selected) navigate(`/onboarding/checkout?plan=${selected.plan.id}`);
                }}
              >
                Continue
              </Button>
              <button
                type="button"
                className={styles.signOut}
                disabled={signOutMutation.isPending}
                onClick={() => signOutMutation.mutate()}
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SelectablePlanCard({
  card,
  selected,
  onSelect,
}: {
  card: PlanCard;
  selected: boolean;
  onSelect: () => void;
}) {
  const { plan } = card;
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={[styles.card, selected ? styles.cardSelected : ''].join(' ')}
      onClick={onSelect}
    >
      <span className={styles.cardHeader}>
        <span className={styles.cardName}>{tierLabel(plan.tier)}</span>
        {selected && (
          <span className={styles.checkCircle} aria-hidden>
            <Check strokeWidth={3} />
          </span>
        )}
      </span>
      <span className={styles.priceRow}>
        <span className={styles.price}>{formatAmount(plan.amountCents)}</span>
        <span className={styles.priceSuffix}>{periodSuffix(plan.interval)}</span>
      </span>
      <span className={styles.priceCaption}>{billingCaption(plan)}</span>
      {plan.features.length > 0 && (
        <span className={styles.features}>
          {plan.features.map((feature) => (
            <span key={feature} className={styles.feature}>
              <Check aria-hidden className={styles.featureIcon} strokeWidth={3} />
              {feature}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/** Invite-only tier (Figma: the "Pro" card): visible but not selectable. */
function LockedPlanCard({ card }: { card: PlanCard }) {
  const { plan } = card;
  return (
    <div className={styles.lockedCard}>
      <span className={styles.cardHeader}>
        <span className={styles.cardName}>{tierLabel(plan.tier)}</span>
        <Badge variant="neutral" className={styles.inviteBadge}>
          Invite only
        </Badge>
      </span>
      {plan.features.length > 0 && (
        <span className={styles.lockedSummary}>{plan.features.join(' · ')}</span>
      )}
    </div>
  );
}

/** Card titles per the Figma: "Member" / "Pro", falling back to the tier name. */
function tierLabel(tier: string): string {
  if (tier === 'member') return 'Member';
  if (tier === 'pro') return 'Pro';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}
