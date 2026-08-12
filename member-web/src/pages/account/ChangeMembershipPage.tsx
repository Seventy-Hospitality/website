import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import {
  api,
  ApiError,
  type BillingInterval,
  type MembershipPlanSummary,
  type MembershipSummary,
  type Plan,
} from '../../lib/api';
import {
  billingCaption,
  defaultBillingPeriod,
  formatAmount,
  listBillingPeriods,
  PERIOD_LABELS,
  periodSuffix,
  planCardsForPeriod,
} from '../../lib/plan-pricing';
import { planChangeKind, planChangeSummary } from '../../lib/membership-change';
import { getStripe } from '../../lib/stripe';
import { PageHeader } from '../../app/AppShell';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  SegmentedControl,
  Sheet,
  Skeleton,
  useToast,
} from '../../components';
import { membershipQuery, plansQuery } from '../onboarding/onboarding-data';
import { canCancelMembership, canChangeMembership, instantDateLabel } from './account-lib';
import { ProrationPaymentForm } from './ProrationPaymentForm';
import styles from './account.module.css';

/**
 * Change membership (the billing card's accent row). Reuses W1's
 * plan-pricing catalog logic (period toggle + one card per tier) and its
 * Stripe patterns for the paid-upgrade path.
 *
 * Proration policy mirrored from the backend (lib/membership-change.ts):
 * upgrades (tier up, monthly -> annual, price up) apply immediately with a
 * prorated charge; POST /api/me/membership/change returns a clientSecret
 * when that charge needs collection/SCA, confirmed here with the Payment
 * Element and read back via POST /api/me/membership/confirm (W1's
 * subscribe/confirm + paymentStatus handling). Downgrades schedule at
 * period end, no refund, no payment step.
 *
 * Cancel membership lives here too: at period end by default, with an
 * explicit cancel-now option, behind a focus-trapped confirm Sheet. Plan
 * changes need an ACTIVE membership (the backend's active-member policy),
 * but cancel stays available for any live one: DELETE /api/me/membership
 * uses policy `member` so a past_due member can always stop paying, and
 * this screen renders its cancel zone for those states too.
 */
export function ChangeMembershipPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const plans = useQuery(plansQuery);
  const overview = useQuery(membershipQuery);
  const redirectStatus = searchParams.get('redirect_status');

  if (plans.isPending || overview.isPending) {
    return (
      <ChangeFrame>
        <div role="status" aria-busy="true" className={styles.loadingStack}>
          <span className="visually-hidden">Loading membership options</span>
          <Skeleton height="6rem" shape="card" />
          <Skeleton height="6rem" shape="card" />
        </div>
      </ChangeFrame>
    );
  }

  if (plans.isError || overview.isError) {
    return (
      <ChangeFrame>
        <div className={styles.errorBox} role="alert">
          <p>We could not load your membership options.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (plans.isError) void plans.refetch();
              if (overview.isError) void overview.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      </ChangeFrame>
    );
  }

  const membership = overview.data.membership;
  if (!membership?.plan || (!canChangeMembership(membership) && !canCancelMembership(membership))) {
    return (
      <ChangeFrame>
        <EmptyState
          title="No active membership to change"
          description="Membership changes need an active membership. Check your billing page for the current state."
        />
      </ChangeFrame>
    );
  }

  return (
    <ChangeView
      plans={plans.data}
      membership={membership}
      currentPlan={membership.plan}
      canChangePlans={canChangeMembership(membership)}
      redirectStatus={redirectStatus}
      clearRedirectParams={() =>
        setSearchParams(
          (params) => {
            const next = new URLSearchParams(params);
            next.delete('redirect_status');
            next.delete('payment_intent');
            next.delete('payment_intent_client_secret');
            next.delete('source_type');
            return next;
          },
          { replace: true },
        )
      }
    />
  );
}

function ChangeFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <Link to="/account/billing" className={styles.backLink}>
        <ChevronLeft aria-hidden />
        Back to billing
      </Link>
      <PageHeader title="Change membership" />
      {children}
    </div>
  );
}

function ChangeView({
  plans,
  membership,
  currentPlan,
  canChangePlans,
  redirectStatus,
  clearRedirectParams,
}: {
  plans: Plan[];
  membership: MembershipSummary;
  currentPlan: MembershipPlanSummary;
  /** False for a live-but-not-active membership: cancel only, no plan switches. */
  canChangePlans: boolean;
  redirectStatus: string | null;
  clearRedirectParams: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const periods = listBillingPeriods(plans);
  const [period, setPeriod] = useState<BillingInterval>(() =>
    periods.includes(currentPlan.interval) ? currentPlan.interval : defaultBillingPeriod(plans),
  );
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [processingHold, setProcessingHold] = useState(false);
  // A failed redirect-based proration payment: the plan already switched
  // server-side (allow_incomplete), so surface the unpaid state instead of
  // holding; Stripe retries the open invoice against the default card.
  const failedRedirect =
    redirectStatus === 'failed' || redirectStatus === 'requires_payment_method';
  const [payNotice, setPayNotice] = useState<string | null>(
    failedRedirect
      ? 'Your plan was changed, but the payment did not complete. We will retry the charge; check your payment method on the billing page.'
      : null,
  );
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelNow, setCancelNow] = useState(false);
  const planGroupRef = useRef<HTMLDivElement>(null);

  const stripeReady = getStripe() !== null;
  const periodEndLabel = instantDateLabel(membership.currentPeriodEnd);

  function invalidateBillingState() {
    void queryClient.invalidateQueries({ queryKey: ['membership'] });
    void queryClient.invalidateQueries({ queryKey: ['billing'] });
    void queryClient.invalidateQueries({ queryKey: ['profile'] });
    void queryClient.invalidateQueries({ queryKey: ['home'] });
  }

  function finish(message: string) {
    invalidateBillingState();
    toast({ message, variant: 'success' });
    navigate('/account/billing', { replace: true });
  }

  /** W1's read-back: activated/succeeded ends the flow, processing holds. */
  const confirm = useMutation({
    mutationFn: api.confirmMembership,
    onSuccess: (data) => {
      if (data.activated || data.paymentStatus === 'succeeded') {
        finish('Membership updated');
      } else if (data.paymentStatus === 'processing') {
        setProcessingHold(true);
      } else {
        setPayNotice('Your payment was not completed. Please try again.');
      }
    },
  });

  const change = useMutation({
    mutationFn: (planId: string) => api.changeMembership(planId),
    onSuccess: (result) => {
      if (result.kind === 'downgrade_scheduled') {
        finish(
          `Plan change scheduled for ${
            result.pendingPlanEffectiveAt
              ? instantDateLabel(result.pendingPlanEffectiveAt)
              : periodEndLabel
          }`,
        );
      } else if (result.clientSecret === null) {
        // Upgrade with nothing to collect (covered by credit).
        finish('Membership updated');
      }
      // clientSecret set: the proration payment form renders below.
    },
  });

  const cancel = useMutation({
    mutationFn: (options: { now: boolean }) => api.cancelMembership(options),
    onSuccess: (result) => {
      finish(
        result.canceledImmediately
          ? 'Your membership has been canceled'
          : `Your membership ends ${instantDateLabel(result.effectiveAt)}`,
      );
    },
    onError: () => {
      toast({ message: 'We could not cancel your membership. Please try again.', variant: 'error' });
    },
  });

  // Returned from a redirect-based proration payment: clean the URL and,
  // unless the redirect already reported failure, read the result back.
  const redirectHandled = useRef(false);
  const confirmMutate = confirm.mutate;
  useEffect(() => {
    if (redirectStatus === null || redirectHandled.current) return;
    redirectHandled.current = true;
    clearRedirectParams();
    if (!failedRedirect) confirmMutate();
  }, [redirectStatus, failedRedirect, clearRedirectParams, confirmMutate]);

  const cards = planCardsForPeriod(plans, period);
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId) ?? null;
  const clientSecret = change.data?.clientSecret ?? null;
  const changeKind = selectedPlan ? planChangeKind(currentPlan, selectedPlan) : null;

  // ── Radio-group keyboard pattern (roving tabindex, SegmentedControl is
  // the CONVENTIONS reference): the group is ONE tab stop and arrow keys
  // move the selection across the selectable cards.
  const rovingPlanId =
    selectedPlanId !== null && cards.some((card) => card.plan.id === selectedPlanId)
      ? selectedPlanId
      : (cards.find((card) => !card.locked)?.plan.id ?? null);

  function movePlanSelection(fromPlanId: string, offset: number) {
    const selectable = cards.filter((card) => !card.locked);
    if (selectable.length === 0) return;
    const from = selectable.findIndex((card) => card.plan.id === fromPlanId);
    const next = selectable[(from + offset + selectable.length) % selectable.length];
    setSelectedPlanId(next.plan.id);
    const radios = planGroupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.[cards.indexOf(next)]?.focus();
  }

  const changeError = change.isError
    ? change.error instanceof ApiError && change.error.code !== 'UNKNOWN'
      ? change.error.message
      : 'We could not change your membership. Please try again.'
    : null;

  // ── Paid-upgrade payment step (Payment Element on the proration invoice) ──
  if (clientSecret !== null || processingHold || confirm.isPending || confirm.isError) {
    return (
      <ChangeFrame>
        {processingHold ? (
          <div className={styles.processing} role="status">
            <p className={styles.processingTitle}>Your payment is processing</p>
            <p className={styles.processingBody}>
              Your plan change completes as soon as the payment clears. This can take a moment
              for some payment methods.
            </p>
            <Button
              variant="secondary"
              size="sm"
              loading={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              Check again
            </Button>
          </div>
        ) : (
          <>
            <p className={styles.changeSummaryText}>
              Confirm the prorated charge to finish switching to{' '}
              {selectedPlan?.name ?? 'your new plan'}.
            </p>
            {confirm.isError && (
              <div className={styles.errorBox} role="alert">
                <p>
                  Your payment went through, but we could not confirm the change. Retry; you
                  will not be charged twice.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={confirm.isPending}
                  onClick={() => confirm.mutate()}
                >
                  Try again
                </Button>
              </div>
            )}
            {clientSecret !== null && (
              <ProrationPaymentForm
                clientSecret={clientSecret}
                payNotice={payNotice}
                returnUrl={`${window.location.origin}/account/membership`}
                confirmPending={confirm.isPending}
                onPaid={() => {
                  setPayNotice(null);
                  confirm.mutate();
                }}
              />
            )}
          </>
        )}
      </ChangeFrame>
    );
  }

  return (
    <ChangeFrame>
      {payNotice && (
        <p role="alert" className={styles.payAlert}>
          {payNotice}
        </p>
      )}

      {!canChangePlans && (
        <div className={styles.changeSummary}>
          <p className={styles.changeSummaryText}>
            {membership.status === 'past_due' || membership.status === 'unpaid'
              ? 'Your payment is past due, so plan changes are unavailable. Update your payment method from the billing page to keep your membership, or cancel it below.'
              : 'Plan changes need an active membership. You can still cancel your membership below.'}
          </p>
        </div>
      )}

      {canChangePlans && periods.length > 1 && (
        <SegmentedControl
          label="Billing period"
          options={periods.map((value) => ({ value, label: PERIOD_LABELS[value] }))}
          value={period}
          onChange={(value) => {
            setPeriod(value);
            setSelectedPlanId(null);
          }}
        />
      )}

      {canChangePlans && (
        <div
          ref={planGroupRef}
          className={styles.planCards}
          role="radiogroup"
          aria-label="Membership plans"
        >
          {cards.map((card) => {
            const isCurrent = card.plan.id === currentPlan.id;
            const isPending = membership.pendingPlan?.id === card.plan.id;
            const selected = card.plan.id === selectedPlanId;
            return (
              <button
                key={card.plan.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={card.locked}
                tabIndex={card.plan.id === rovingPlanId ? 0 : -1}
                className={[styles.planCardButton, selected ? styles.planCardSelected : '']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => setSelectedPlanId(card.plan.id)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    movePlanSelection(card.plan.id, 1);
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    movePlanSelection(card.plan.id, -1);
                  }
                }}
              >
                <span className={styles.planCardHead}>
                  <span className={styles.planCardName}>
                    {card.plan.name}
                    {isCurrent && <Badge variant="accent">Current plan</Badge>}
                    {isPending && <Badge variant="neutral">Scheduled</Badge>}
                    {card.locked && <Badge variant="neutral">Invite only</Badge>}
                  </span>
                  <span className={styles.planPrice}>
                    {formatAmount(card.plan.amountCents)}
                    <span className="visually-hidden"> </span>
                    {periodSuffix(card.plan.interval)}
                  </span>
                </span>
                <span className={styles.planCardCaption}>{billingCaption(card.plan)}</span>
              </button>
            );
          })}
        </div>
      )}

      {canChangePlans && selectedPlan && selectedPlan.id !== currentPlan.id && changeKind && (
        <div className={styles.changeSummary}>
          <p className={styles.changeSummaryText}>{planChangeSummary(changeKind, periodEndLabel)}</p>
          {changeKind === 'upgrade' && !stripeReady && (
            <p className={styles.dialogHint}>
              Payments are not configured in this environment; an upgrade that needs a charge
              cannot be completed.
            </p>
          )}
          {changeError && (
            <p role="alert" className={styles.payAlert}>
              {changeError}
            </p>
          )}
          <Button
            fullWidth
            loading={change.isPending}
            onClick={() => change.mutate(selectedPlan.id)}
          >
            {changeKind === 'upgrade' ? 'Switch now' : `Switch on ${periodEndLabel}`}
          </Button>
        </div>
      )}

      {canChangePlans && selectedPlan && selectedPlan.id === currentPlan.id && membership.pendingPlan && (
        <div className={styles.changeSummary}>
          <p className={styles.changeSummaryText}>
            Staying on {currentPlan.name} removes the scheduled switch to{' '}
            {membership.pendingPlan.name}.
          </p>
          {changeError && (
            <p role="alert" className={styles.payAlert}>
              {changeError}
            </p>
          )}
          <Button fullWidth loading={change.isPending} onClick={() => change.mutate(selectedPlan.id)}>
            Keep {currentPlan.name}
          </Button>
        </div>
      )}

      <div className={styles.cancelZone}>
        <button type="button" className={styles.textDanger} onClick={() => setCancelOpen(true)}>
          Cancel membership
        </button>
      </div>

      {/* ── Cancel confirmation (focus-trapped Sheet) ── */}
      <Sheet
        open={cancelOpen}
        onClose={() => {
          if (!cancel.isPending) setCancelOpen(false);
        }}
        title="Cancel membership"
        footer={
          <div className={styles.dialogActions}>
            <Button
              variant="danger"
              fullWidth
              loading={cancel.isPending}
              onClick={() => cancel.mutate({ now: cancelNow })}
            >
              {cancelNow ? 'Cancel immediately' : 'Cancel membership'}
            </Button>
            <Button
              variant="secondary"
              fullWidth
              disabled={cancel.isPending}
              onClick={() => setCancelOpen(false)}
            >
              Keep membership
            </Button>
          </div>
        }
      >
        <div className={styles.dialogBody}>
          {membership.cancelAtPeriodEnd ? (
            <p className={styles.dialogText}>
              Your membership is already set to end on {periodEndLabel}. You can still cancel
              immediately below.
            </p>
          ) : canChangePlans ? (
            <p className={styles.dialogText}>
              Your membership stays active until {periodEndLabel}, then ends. You will not be
              charged again.
            </p>
          ) : (
            // Not active (e.g. past due): do not claim it "stays active".
            <p className={styles.dialogText}>
              Your membership ends on {periodEndLabel}. You will not be charged again.
            </p>
          )}
          <Checkbox
            checked={cancelNow}
            onChange={(event) => setCancelNow(event.target.checked)}
            label="Cancel immediately instead. Access ends now and the remaining time is not refunded."
          />
        </div>
      </Sheet>
    </ChangeFrame>
  );
}
