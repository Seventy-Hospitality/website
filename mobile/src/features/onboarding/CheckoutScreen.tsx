/**
 * Onboarding step 2 (Figma onboarding/checkout 26:841 / 32:569), native.
 *
 * Subscription-first Stripe flow, adapted from the web Elements version to the
 * native PaymentSheet. Because the sheet is presented on demand (not an inline
 * element that needs a client secret to render), we subscribe lazily when the
 * member commits by tapping Confirm with the terms checkbox checked:
 *
 *  1. POST /api/me/membership/subscribe (plan + termsVersion) creates (or
 *     re-enters) a default_incomplete subscription and returns the
 *     confirmation client secret + the customer id + ephemeral key for the
 *     saved-cards sheet. Card data never touches our code (PCI SAQ A).
 *  2. usePaymentSheet() presents the native sheet on that secret; the sheet
 *     handles decline/SCA. We map canceled / failed / unconfigured explicitly.
 *  3. On completed, POST /api/me/membership/confirm reads the subscription
 *     back synchronously and activates the membership; on success we advance
 *     to the ID step. A charge that reached Stripe but has not cleared
 *     (processing) parks in a "payment processing" hold with a manual re-check
 *     instead of a retry that could double-charge; a genuinely failed charge
 *     returns to the form.
 */
import { useState } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  api,
  ApiError,
  type MembershipStatus,
  type OnboardingState,
  type Plan,
} from '../../lib/api';
import { useSession } from '../../lib/session';
import { usePaymentSheet, usePaymentsConfigured } from '../../lib/stripe';
import { AppScreen } from '../../components/AppScreen';
import { Checkbox } from '../../components/Checkbox';
import { PrimaryButton } from '../../components/PrimaryButton';
import { Skeleton } from '../../components/Skeleton';
import { colors, fonts, radius, spacing, typography } from '../../theme/tokens';
import { TERMS_VERSION } from './onboarding';
import { formatAmountWithCents } from './plan-pricing';
import { billingQuery, plansQuery } from './queries';

/** What the summary + subscribe call need; satisfied by a catalog Plan row
    or by the plan summary on an incomplete membership (resume). */
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
  membershipPlan: CheckoutPlan | null,
  membershipStatus: MembershipStatus | null,
): CheckoutPlan | null {
  if (planParam !== null) {
    const row = plans.find((plan) => plan.id === planParam);
    return row && row.active && !row.inviteOnly ? row : null;
  }
  // No plan param: resume an unpaid purchase from its membership row.
  if (membershipStatus === 'incomplete' && membershipPlan) return membershipPlan;
  return null;
}

type PayPhase = 'idle' | 'paying' | 'processing';

export function CheckoutScreen() {
  const params = useLocalSearchParams<{ plan?: string | string[] }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { refresh, emailVerified } = useSession();
  const configured = usePaymentsConfigured();
  const presentSheet = usePaymentSheet();

  const planParam = Array.isArray(params.plan) ? (params.plan[0] ?? null) : (params.plan ?? null);

  const plans = useQuery(plansQuery);
  // Only read billing to recover the plan when resuming without a ?plan param.
  const billing = useQuery({ ...billingQuery, enabled: planParam === null });

  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<PayPhase>('idle');
  const [payError, setPayError] = useState<string | null>(null);

  const subscribe = useMutation({ mutationFn: api.subscribeMembership });
  const confirm = useMutation({ mutationFn: api.confirmMembership });

  const plansPending = plans.isPending;
  const billingPending = planParam === null && billing.isPending;

  if (plansPending || billingPending) {
    return (
      <CheckoutFrame>
        <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel="Loading checkout">
          <Skeleton height={150} borderRadius={radius.lg} />
          <Skeleton height={120} borderRadius={radius.lg} />
        </View>
      </CheckoutFrame>
    );
  }

  if (plans.isError || (planParam === null && billing.isError)) {
    return (
      <CheckoutFrame>
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load your checkout.</Text>
          <PrimaryButton
            label="Try again"
            variant="ghost"
            onPress={() => {
              if (plans.isError) void plans.refetch();
              if (billing.isError) void billing.refetch();
            }}
          />
        </View>
        <BackToPlans />
      </CheckoutFrame>
    );
  }

  const membershipSummary = billing.data?.membership ?? null;
  const activePlan = resolveCheckoutPlan(
    planParam,
    plans.data ?? [],
    membershipSummary?.plan
      ? {
          id: membershipSummary.plan.id,
          name: membershipSummary.plan.name,
          amountCents: membershipSummary.plan.amountCents,
          interval: membershipSummary.plan.interval,
          tier: membershipSummary.plan.tier,
        }
      : null,
    membershipSummary?.status ?? null,
  );

  // No resolvable plan (bad/missing ?plan and nothing to resume): choose one.
  if (activePlan === null) {
    return <Redirect href="/onboarding/plan" />;
  }

  const busy = phase !== 'idle';

  // Self-contained: never rejects, so the "Check again" handler in the
  // processing hold can call it without an unhandled rejection.
  async function runConfirm(): Promise<void> {
    let data;
    try {
      data = await confirm.mutateAsync();
    } catch {
      // Confirm failed (network/5xx) AFTER the charge reached Stripe. Park in
      // the processing hold with a manual re-check; the card is not charged
      // twice by retrying the read.
      setPayError('Your payment went through, but we could not confirm your membership. Try again.');
      setPhase('processing');
      return;
    }

    if (data.activated) {
      setPayError(null);
      // Patch the resume cache to the ID step BEFORE navigating so the gate
      // resolves the new step from fresh data (no bounce back to checkout).
      queryClient.setQueryData<OnboardingState>(['onboarding'], (prev) => ({
        emailVerified: prev?.emailVerified ?? emailVerified,
        membership: { status: data.membership?.status ?? 'active', everLive: true },
        idVerification: prev?.idVerification ?? { status: 'not_submitted', skippedAt: null },
        nextStep: 'id-verification',
      }));
      void queryClient.invalidateQueries({ queryKey: ['onboarding'], refetchType: 'none' });
      void queryClient.invalidateQueries({ queryKey: ['membership'], refetchType: 'none' });
      void queryClient.invalidateQueries({ queryKey: ['billing'], refetchType: 'none' });
      // The membership is active server-side and the resume cache is already
      // patched to the ID step, so navigating is safe regardless of refresh.
      // Guard it so a transient getMe() blip cannot strand a paid member on
      // the processing hold (and cannot reject the "Check again" caller) —
      // this is what keeps runConfirm's "never rejects" contract true.
      try {
        await refresh();
      } catch {
        // Session read failed transiently; the gate re-reads on the next
        // screen. Proceed to the ID step either way.
      }
      setPhase('idle');
      router.replace('/onboarding/verify-identity');
      return;
    }

    // Charge reached Stripe but the subscription is not active yet.
    if (data.paymentStatus === 'requires_payment_method' || data.paymentStatus === 'canceled') {
      setPayError('Your payment was not completed. Please try again.');
      setPhase('idle');
      return;
    }
    // processing / requires_action / succeeded-but-not-yet-active / unknown:
    // an async method still clearing. Offer a manual re-check, not a retry.
    setPayError(null);
    setPhase('processing');
  }

  async function pay(plan: CheckoutPlan): Promise<void> {
    if (busy) return;
    setPayError(null);

    if (!configured) {
      setPayError('Payments are not configured in this environment.');
      return;
    }

    setPhase('paying');
    try {
      let sub;
      try {
        sub = await subscribe.mutateAsync({ planId: plan.id, termsVersion: TERMS_VERSION });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'MEMBERSHIP_ERROR') {
          // Already has a membership (paid elsewhere / a webhook raced us).
          // Refresh the resume read and let the gate route to the right step.
          await queryClient.invalidateQueries({ queryKey: ['onboarding'] });
          await refresh();
          setPhase('idle');
          return;
        }
        setPayError(
          err instanceof ApiError && err.code !== 'UNKNOWN'
            ? err.message
            : 'We could not start your checkout.',
        );
        setPhase('idle');
        return;
      }

      // A subscription with nothing to collect is confirmed directly.
      if (sub.clientSecret !== null) {
        const result = await presentSheet({
          clientSecret: sub.clientSecret,
          customerId: sub.customerId,
          ephemeralKeySecret: sub.ephemeralKeySecret,
          merchantDisplayName: 'Club70',
        });
        if (result.status === 'unconfigured') {
          setPayError('Payments are not configured in this environment.');
          setPhase('idle');
          return;
        }
        if (result.status === 'canceled') {
          // The member dismissed the sheet; the incomplete subscription is
          // re-entrant, so leave everything as-is for another attempt.
          setPhase('idle');
          return;
        }
        if (result.status === 'failed') {
          setPayError(result.message || 'Your payment could not be completed.');
          setPhase('idle');
          return;
        }
      }

      await runConfirm();
    } catch {
      setPayError('Something went wrong completing your payment. Please try again.');
      setPhase('idle');
    }
  }

  return (
    <CheckoutFrame>
      <OrderSummary plan={activePlan} />

      {!configured && (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.emptyTitle}>Payments are not configured</Text>
          <Text style={styles.emptyBody}>
            Set EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY to enable checkout in this environment.
          </Text>
        </View>
      )}

      {configured && phase === 'processing' && (
        <View style={styles.processing} accessibilityRole="progressbar">
          {payError && (
            <Text style={styles.payAlert} accessibilityRole="alert">
              {payError}
            </Text>
          )}
          <Text style={styles.processingTitle}>Your payment is processing</Text>
          <Text style={styles.processingBody}>
            Your membership will activate as soon as the payment clears. This can take a moment for
            some payment methods.
          </Text>
          <PrimaryButton
            label="Check again"
            variant="ghost"
            loading={confirm.isPending}
            onPress={() => void runConfirm()}
          />
        </View>
      )}

      {configured && phase !== 'processing' && (
        <>
          <PaymentMethodNotice />

          <Checkbox
            checked={agreed}
            onChange={setAgreed}
            accessibilityLabel="I agree to the Terms and Conditions"
            label={
              <Text style={styles.termsLabel}>
                I agree to the <Text style={styles.termsLink}>Terms and Conditions</Text>
              </Text>
            }
          />

          {payError && (
            <Text style={styles.payAlert} accessibilityRole="alert">
              {payError}
            </Text>
          )}
        </>
      )}

      <View style={styles.footer}>
        <BackToPlans />
        {configured && phase !== 'processing' && (
          <PrimaryButton
            label="Confirm membership"
            loading={busy}
            disabled={!agreed}
            onPress={() => {
              if (!busy) void pay(activePlan);
            }}
          />
        )}
      </View>
    </CheckoutFrame>
  );
}

function CheckoutFrame({ children }: { children: React.ReactNode }) {
  return (
    <AppScreen contentStyle={styles.content}>
      <Text style={styles.title}>Checkout</Text>
      {children}
    </AppScreen>
  );
}

function BackToPlans() {
  const router = useRouter();
  return (
    <Pressable accessibilityRole="link" onPress={() => router.replace('/onboarding/plan')}>
      <Text style={styles.footerLink}>Back to memberships</Text>
    </Pressable>
  );
}

/** Native translation of the Figma "CARD DETAILS" block: the card is entered
    in the secure native sheet, so we never render raw card fields. */
function PaymentMethodNotice() {
  return (
    <View style={styles.paymentNotice}>
      <Text style={styles.sectionLabel}>Payment</Text>
      <View style={styles.paymentRow}>
        <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} />
        <Text style={styles.paymentText}>
          Card details are entered securely when you confirm.
        </Text>
      </View>
    </View>
  );
}

function OrderSummary({ plan }: { plan: CheckoutPlan }) {
  const yearly = plan.interval === 'year';
  const description =
    plan.tier === 'member'
      ? `Standard ${yearly ? 'annual' : 'monthly'} club membership`
      : plan.name;

  return (
    <View style={styles.summary}>
      <Text style={styles.sectionLabel}>Order summary</Text>
      <View style={styles.summaryRow}>
        <Text style={styles.summaryFeeLabel}>Membership fee</Text>
        <Text style={styles.summaryPrice}>
          {formatAmountWithCents(plan.amountCents)}
          <Text style={styles.summaryPeriod}> /{yearly ? 'year' : 'month'}</Text>
        </Text>
      </View>
      <Text style={styles.summaryCaption}>{description}</Text>
      <View style={styles.divider} />
      <View style={styles.summaryRow}>
        <Text style={styles.totalLabel}>Total due today</Text>
        <Text style={styles.totalValue}>{formatAmountWithCents(plan.amountCents)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
  },
  title: {
    ...typography.display,
    color: colors.text,
    marginTop: spacing.sm,
  },
  loading: {
    gap: spacing.md,
  },
  errorBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  errorText: {
    ...typography.body,
    color: colors.text,
  },
  emptyTitle: {
    ...typography.h3,
    color: colors.text,
  },
  emptyBody: {
    ...typography.body,
    color: colors.textMuted,
  },
  summary: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionLabel: {
    ...typography.label,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  summaryFeeLabel: {
    ...typography.bodyStrong,
    color: colors.text,
  },
  summaryPrice: {
    ...typography.bodyStrong,
    color: colors.text,
  },
  summaryPeriod: {
    ...typography.caption,
    color: colors.textMuted,
  },
  summaryCaption: {
    ...typography.caption,
    color: colors.textSubtle,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  totalLabel: {
    ...typography.bodyStrong,
    color: colors.text,
  },
  totalValue: {
    fontFamily: fonts.displayBold,
    fontSize: 22,
    color: colors.accent,
  },
  paymentNotice: {
    gap: spacing.sm,
  },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  paymentText: {
    ...typography.body,
    color: colors.textMuted,
    flex: 1,
  },
  termsLabel: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
  termsLink: {
    color: colors.accent,
    textDecorationLine: 'underline',
  },
  payAlert: {
    ...typography.body,
    color: colors.danger,
  },
  processing: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  processingTitle: {
    ...typography.h3,
    color: colors.text,
  },
  processingBody: {
    ...typography.body,
    color: colors.textMuted,
  },
  footer: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  footerLink: {
    ...typography.bodyStrong,
    color: colors.accent,
    textAlign: 'center',
  },
});
