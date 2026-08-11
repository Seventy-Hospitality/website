import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { api, ApiError, type MembershipSummary, type Plan } from '../../lib/api';
import { TERMS_VERSION } from '../../lib/onboarding';
import { formatAmountWithCents } from '../../lib/plan-pricing';
import { getStripe } from '../../lib/stripe';
import { StripeProvider } from '../../lib/StripeProvider';
import { useSession } from '../../lib/session-context';
import { membershipQuery, plansQuery } from './onboarding-data';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  FullScreenLoader,
  Skeleton,
  Spinner,
} from '../../components';
import layout from './onboarding.module.css';
import styles from './CheckoutPage.module.css';

/**
 * Onboarding step 2 (Figma onboarding/checkout 26:841 / 32:569).
 *
 * Subscription-first Stripe flow:
 *  1. POST /api/me/membership/subscribe (plan + termsVersion) creates a
 *     default_incomplete subscription and returns the confirmation client
 *     secret (re-entrant: retrying the same plan reuses the subscription,
 *     switching plans voids the old one).
 *  2. The Payment Element mounts on that secret (card data never touches
 *     our code: PCI SAQ A).
 *  3. The terms checkbox gates the pay button; stripe.confirmPayment()
 *     handles decline/SCA inline (redirect-based methods return to this
 *     page and are picked up from the redirect params).
 *  4. POST /api/me/membership/confirm reads the subscription back
 *     synchronously and activates the membership; on success the flow
 *     advances to the ID step.
 */

/** What the summary and subscribe call need; satisfied by a catalog Plan
    row or by the plan summary on an incomplete membership (resume). */
interface CheckoutPlan {
  id: string;
  name: string;
  amountCents: number;
  interval: 'month' | 'year';
  tier: string;
}

function resolveCheckoutPlan(
  planParam: string | null,
  plans: Plan[],
  membership: MembershipSummary | null,
): CheckoutPlan | null {
  if (planParam !== null) {
    const row = plans.find((plan) => plan.id === planParam);
    return row && row.active && !row.inviteOnly ? row : null;
  }
  // No plan in the URL: resume an unpaid purchase from its membership row.
  if (membership?.status === 'incomplete' && membership.plan) return membership.plan;
  return null;
}

function checkoutReturnUrl(planId: string): string {
  return `${window.location.origin}/onboarding/checkout?plan=${encodeURIComponent(planId)}`;
}

export function CheckoutPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { refreshSession } = useSession();

  const planParam = searchParams.get('plan');
  const redirectStatus = searchParams.get('redirect_status');

  const plans = useQuery(plansQuery);
  const membership = useQuery(membershipQuery);

  // "Payment landed at Stripe but the subscription is not active yet"
  // (async payment methods); offers a manual re-check instead of a retry
  // that could double-charge.
  const [processingHold, setProcessingHold] = useState(false);
  const [payNotice, setPayNotice] = useState<string | null>(null);

  const confirm = useMutation({
    mutationFn: api.confirmMembership,
    onSuccess: async (data) => {
      // Write the fresh membership into the cache BEFORE navigating so the
      // OnboardingGate resolves the new step from current data.
      queryClient.setQueryData(membershipQuery.queryKey, { membership: data.membership });
      if (data.activated) {
        await refreshSession();
        navigate('/onboarding/verify-identity', { replace: true });
      } else {
        setProcessingHold(true);
      }
    },
  });

  const subscribe = useMutation({
    mutationFn: api.subscribeMembership,
    onError: (error) => {
      // "Already has an active subscription": our membership read is stale
      // (paid elsewhere / a webhook raced us). Refetch and let the gate
      // route to the right step.
      if (error instanceof ApiError && error.code === 'MEMBERSHIP_ERROR') {
        void queryClient.invalidateQueries({ queryKey: membershipQuery.queryKey });
      }
    },
  });

  const stripeReady = getStripe() !== null;

  const plansData = plans.data;
  const membershipData = membership.data;
  const activePlan = useMemo(
    () =>
      plansData !== undefined && membershipData !== undefined
        ? resolveCheckoutPlan(planParam, plansData, membershipData.membership ?? null)
        : undefined,
    [planParam, plansData, membershipData],
  );

  // Returned from a redirect-based payment method: confirm first, then (if
  // the membership did not activate) clean the Stripe params and fall back
  // into the normal flow.
  const redirectHandled = useRef(false);
  const confirmMutate = confirm.mutate;
  useEffect(() => {
    if (redirectStatus === null || redirectHandled.current) return;
    redirectHandled.current = true;
    const failed = redirectStatus === 'failed';
    confirmMutate(undefined, {
      onSettled: (data) => {
        if (data?.activated) return;
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
        );
        if (failed) setPayNotice('Your payment was not completed. Please try again.');
      },
    });
  }, [redirectStatus, confirmMutate, setSearchParams]);

  // Create (or re-enter) the incomplete subscription as soon as the plan is
  // known. Terms acceptance (TERMS_VERSION) is recorded server-side here;
  // the checkbox below still gates the actual payment.
  const startedForPlan = useRef<string | null>(null);
  const subscribeMutate = subscribe.mutate;
  useEffect(() => {
    if (!stripeReady || redirectStatus !== null || processingHold) return;
    if (activePlan == null) return;
    if (startedForPlan.current === activePlan.id) return;
    startedForPlan.current = activePlan.id;
    subscribeMutate({ planId: activePlan.id, termsVersion: TERMS_VERSION });
  }, [stripeReady, redirectStatus, processingHold, activePlan, subscribeMutate]);

  // A subscription with nothing to collect (no confirmation secret) is
  // confirmed directly instead of mounting a payment form on nothing.
  const confirmedWithoutSecret = useRef(false);
  useEffect(() => {
    if (!subscribe.isSuccess || subscribe.data.clientSecret !== null) return;
    if (confirmedWithoutSecret.current) return;
    confirmedWithoutSecret.current = true;
    confirmMutate(undefined);
  }, [subscribe.isSuccess, subscribe.data, confirmMutate]);

  if (redirectStatus !== null) {
    return <FullScreenLoader label="Finalizing your membership" />;
  }

  if (plans.isPending || membership.isPending) {
    return (
      <CheckoutFrame>
        <div className={styles.loading} aria-busy="true" role="status">
          <span className="visually-hidden">Loading checkout</span>
          <Skeleton height="10rem" shape="card" />
          <Skeleton height="14rem" shape="card" />
        </div>
      </CheckoutFrame>
    );
  }

  if (plans.isError || membership.isError) {
    return (
      <CheckoutFrame>
        <div className={layout.errorBox} role="alert">
          <p>We could not load your checkout.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (plans.isError) void plans.refetch();
              if (membership.isError) void membership.refetch();
            }}
          >
            Try again
          </Button>
        </div>
        <BackToPlans />
      </CheckoutFrame>
    );
  }

  // No resolvable plan (bad/missing ?plan and nothing to resume): choose one.
  if (activePlan == null) {
    return <Navigate to="/onboarding/plan" replace />;
  }

  const clientSecret = subscribe.data?.clientSecret ?? null;
  const subscribeConflict =
    subscribe.isError &&
    subscribe.error instanceof ApiError &&
    subscribe.error.code === 'MEMBERSHIP_ERROR';

  return (
    <CheckoutFrame>
      <div className={styles.grid}>
        <OrderSummary plan={activePlan} />

        <div className={styles.paymentArea}>
          {!stripeReady && (
            <>
              <EmptyState
                title="Payments are not configured"
                description="Set VITE_STRIPE_PUBLISHABLE_KEY to enable checkout in this environment."
              />
              <BackToPlans />
            </>
          )}

          {stripeReady && processingHold && (
            <>
              <div className={styles.processing} role="status">
                <p className={styles.processingTitle}>Your payment is processing</p>
                <p className={styles.processingBody}>
                  Your membership will activate as soon as the payment clears. This can take a
                  moment for some payment methods.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={confirm.isPending}
                  onClick={() => confirm.mutate(undefined)}
                >
                  Check again
                </Button>
              </div>
              <BackToPlans />
            </>
          )}

          {stripeReady && !processingHold && (
            <>
              {subscribe.isPending && (
                <div className={styles.loading} aria-busy="true" role="status">
                  <span className="visually-hidden">Preparing secure payment</span>
                  <Skeleton height="12rem" shape="card" />
                  <Skeleton height="2.75rem" shape="card" />
                </div>
              )}

              {subscribeConflict && (
                <div className={styles.processing} role="status">
                  <Spinner size={20} />
                  <p className={styles.processingBody}>
                    You already have a membership in progress; checking its status.
                  </p>
                </div>
              )}

              {subscribe.isError && !subscribeConflict && (
                <>
                  <div className={layout.errorBox} role="alert">
                    <p>
                      {subscribe.error instanceof ApiError &&
                      subscribe.error.code !== 'UNKNOWN'
                        ? subscribe.error.message
                        : 'We could not start your checkout.'}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        startedForPlan.current = activePlan.id;
                        subscribe.mutate({
                          planId: activePlan.id,
                          termsVersion: TERMS_VERSION,
                        });
                      }}
                    >
                      Try again
                    </Button>
                  </div>
                  <BackToPlans />
                </>
              )}

              {clientSecret !== null && (
                <StripeProvider key={clientSecret} clientSecret={clientSecret}>
                  <PaymentForm
                    planId={activePlan.id}
                    payNotice={payNotice}
                    confirmPending={confirm.isPending}
                    confirmError={confirm.isError}
                    onRetryConfirm={() => confirm.mutate(undefined)}
                    onPaid={async () => {
                      setPayNotice(null);
                      await confirm.mutateAsync(undefined).catch(() => undefined);
                    }}
                  />
                </StripeProvider>
              )}
            </>
          )}
        </div>
      </div>
    </CheckoutFrame>
  );
}

function CheckoutFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className={layout.page}>
      <div className={[layout.column, styles.checkoutColumn].join(' ')}>
        <h1 className={layout.title}>Checkout</h1>
        {children}
      </div>
    </div>
  );
}

function BackToPlans() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={layout.footerLink}
      onClick={() => navigate('/onboarding/plan')}
    >
      Back to memberships
    </button>
  );
}

function OrderSummary({ plan }: { plan: CheckoutPlan }) {
  const yearly = plan.interval === 'year';
  const description =
    plan.tier === 'member'
      ? `Standard ${yearly ? 'annual' : 'monthly'} club membership`
      : plan.name;

  return (
    <Card padding="lg" className={styles.summary}>
      <h2 className={styles.summaryTitle}>Order summary</h2>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>Membership fee</span>
        <span className={styles.summaryPrice}>
          {formatAmountWithCents(plan.amountCents)}
          <span className={styles.summaryPeriod}> /{yearly ? 'year' : 'month'}</span>
        </span>
      </div>
      <p className={styles.summaryCaption}>{description}</p>
      <hr className={styles.divider} />
      <div className={styles.summaryRow}>
        <span className={styles.totalLabel}>Total due today</span>
        <span className={styles.totalValue}>{formatAmountWithCents(plan.amountCents)}</span>
      </div>
    </Card>
  );
}

function PaymentForm({
  planId,
  payNotice,
  confirmPending,
  confirmError,
  onRetryConfirm,
  onPaid,
}: {
  planId: string;
  payNotice: string | null;
  confirmPending: boolean;
  confirmError: boolean;
  onRetryConfirm: () => void;
  onPaid: () => Promise<void>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements || paying) return;
    setPaying(true);
    setPayError(null);
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: checkoutReturnUrl(planId) },
        // Cards and SCA challenges complete inline; only redirect-based
        // payment methods leave the page (and return to return_url).
        redirect: 'if_required',
      });
      if (error) {
        setPayError(
          error.type === 'card_error' || error.type === 'validation_error'
            ? (error.message ?? 'Your payment could not be completed.')
            : 'Payment failed. Please check your details and try again.',
        );
        return;
      }
      await onPaid();
    } finally {
      setPaying(false);
    }
  }

  const alert = payError ?? payNotice;

  return (
    <form className={styles.paymentForm} onSubmit={pay} noValidate>
      {!ready && (
        <div aria-busy="true" role="status">
          <span className="visually-hidden">Loading secure payment form</span>
          <Skeleton height="10rem" shape="card" />
        </div>
      )}
      <div className={ready ? undefined : styles.paymentHidden}>
        <PaymentElement onReady={() => setReady(true)} />
      </div>

      <Checkbox
        checked={agreed}
        onChange={(event) => setAgreed(event.target.checked)}
        label={
          <>
            I agree to the <u>Terms and Conditions</u>
          </>
        }
      />

      {alert && (
        <p role="alert" className={styles.payAlert}>
          {alert}
        </p>
      )}

      {confirmError && (
        <div className={layout.errorBox} role="alert">
          <p>
            Your payment went through, but we could not confirm your membership. Retry, or
            refresh this page; you will not be charged twice.
          </p>
          <Button variant="secondary" size="sm" loading={confirmPending} onClick={onRetryConfirm}>
            Try again
          </Button>
        </div>
      )}

      <div className={layout.footer}>
        <BackToPlans />
        <Button
          type="submit"
          fullWidth
          disabled={!ready || !stripe || !agreed}
          loading={paying || confirmPending}
        >
          Confirm membership
        </Button>
      </div>
    </form>
  );
}
