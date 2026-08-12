/**
 * Change membership (M6), native. Mirrors member-web's ChangeMembershipPage:
 * the plan catalog (reusing M1's plan-pricing cards), a preview of upgrade
 * (immediate + prorated) vs downgrade (scheduled at period end), the native
 * PaymentSheet for a proration charge, and a cancel flow (at-period-end default
 * or cancel-now). The POST /change response is authoritative; the client copy
 * only previews direction.
 */
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  ApiError,
  api,
  type BillingInterval,
  type MembershipSummary,
  type Plan,
} from '../../lib/api';
import { usePaymentSheet, usePaymentsConfigured } from '../../lib/stripe';
import {
  Badge,
  Checkbox,
  EmptyStateView,
  PrimaryButton,
  SegmentedControl,
  Sheet,
  Skeleton,
  useToast,
} from '../../components';
import { useVenueTimezone } from '../reserve';
import { plansQuery } from '../onboarding/queries';
import { colors, fonts, radius, spacing, typography } from '../../theme/tokens';
import { AccountFrame } from './AccountFrame';
import { billingQuery, invalidateBillingState } from './account-data';
import {
  PERIOD_LABELS,
  billingCaption,
  canCancelMembership,
  canChangeMembership,
  defaultBillingPeriod,
  formatAmount,
  instantDateLabel,
  listBillingPeriods,
  periodSuffix,
  planCardsForPeriod,
  planChangeKind,
  planChangeSummary,
  tierLabel,
  type PlanChangeKind,
  type PlanCard,
} from './account-lib';

type PayPhase = 'idle' | 'paying' | 'processing';

export function ChangeMembershipScreen() {
  const plans = useQuery(plansQuery);
  const billing = useQuery(billingQuery);

  const pending = plans.isPending || billing.isPending;
  const errored = plans.isError || billing.isError;

  if (pending) {
    return (
      <AccountFrame title="Change membership" backLabel="Back to billing" backTo="/account/billing">
        <View accessibilityLabel="Loading memberships" style={styles.loading}>
          <Skeleton height={44} borderRadius={radius.pill} />
          <Skeleton height={140} borderRadius={radius.lg} />
          <Skeleton height={140} borderRadius={radius.lg} />
        </View>
      </AccountFrame>
    );
  }

  if (errored) {
    return (
      <AccountFrame title="Change membership" backLabel="Back to billing" backTo="/account/billing">
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load your membership.</Text>
          <PrimaryButton
            label="Try again"
            variant="secondary"
            onPress={() => {
              if (plans.isError) void plans.refetch();
              if (billing.isError) void billing.refetch();
            }}
          />
        </View>
      </AccountFrame>
    );
  }

  return <ChangeView plans={plans.data ?? []} membership={billing.data?.membership ?? null} />;
}

function ChangeView({
  plans,
  membership,
}: {
  plans: Plan[];
  membership: MembershipSummary | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const timezone = useVenueTimezone();
  const { toast } = useToast();
  const configured = usePaymentsConfigured();
  const presentSheet = usePaymentSheet();

  const currentPlan = membership?.plan ?? null;
  const canChange = canChangeMembership(membership);
  const canCancel = canCancelMembership(membership);

  const periods = listBillingPeriods(plans);
  const [period, setPeriod] = useState<BillingInterval>(() => {
    if (currentPlan && periods.includes(currentPlan.interval)) return currentPlan.interval;
    return defaultBillingPeriod(plans);
  });
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [payPhase, setPayPhase] = useState<PayPhase>('idle');
  const [payNotice, setPayNotice] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelNow, setCancelNow] = useState(false);

  const periodEndLabel = membership
    ? instantDateLabel(membership.currentPeriodEnd, timezone)
    : '';

  const change = useMutation({ mutationFn: api.changeMembership });
  const confirm = useMutation({ mutationFn: api.confirmMembership });
  const cancel = useMutation({ mutationFn: api.cancelMembership });

  const busy =
    change.isPending || confirm.isPending || cancel.isPending || payPhase !== 'idle';

  const finish = useCallback(
    (message: string) => {
      invalidateBillingState(queryClient);
      toast({ variant: 'success', message });
      if (router.canGoBack()) router.back();
      else router.replace('/account/billing');
    },
    [queryClient, toast, router],
  );

  const runConfirm = useCallback(async () => {
    let data;
    try {
      data = await confirm.mutateAsync();
    } catch {
      setPayNotice('Your payment went through, but we could not confirm the change. Try again.');
      setPayPhase('processing');
      return;
    }
    if (data.activated || data.paymentStatus === 'succeeded') {
      finish('Membership updated');
      return;
    }
    if (data.paymentStatus === 'requires_payment_method' || data.paymentStatus === 'canceled') {
      setPayNotice('Your payment was not completed. Please try again.');
      setPayPhase('idle');
      return;
    }
    setPayNotice(null);
    setPayPhase('processing');
  }, [confirm, finish]);

  const payProration = useCallback(
    async (secret: string) => {
      if (!configured) {
        setPayNotice('Payments are not configured in this environment.');
        setPayPhase('idle');
        return;
      }
      setPayPhase('paying');
      const result = await presentSheet({ clientSecret: secret, merchantDisplayName: 'Club70' });
      if (result.status === 'unconfigured') {
        setPayNotice('Payments are not configured in this environment.');
        setPayPhase('idle');
        return;
      }
      if (result.status === 'canceled') {
        // The upgrade already applied server-side (allow_incomplete); the
        // proration invoice stays open. Keep the payment step so the member can
        // retry, and point them at billing.
        setPayNotice(
          'Your plan was changed, but the payment did not complete. Retry below, or update your payment method on the billing page.',
        );
        setPayPhase('idle');
        return;
      }
      if (result.status === 'failed') {
        setPayNotice(result.message || 'Your payment could not be completed.');
        setPayPhase('idle');
        return;
      }
      await runConfirm();
    },
    [configured, presentSheet, runConfirm],
  );

  const onSwitch = useCallback(
    async (planId: string) => {
      if (busy) return;
      setChangeError(null);
      setPayNotice(null);
      let result;
      try {
        result = await change.mutateAsync(planId);
      } catch (err) {
        setChangeError(
          err instanceof ApiError && err.code !== 'UNKNOWN'
            ? err.message
            : 'We could not change your membership. Please try again.',
        );
        return;
      }
      if (result.kind === 'downgrade_scheduled') {
        finish(
          `Plan change scheduled for ${
            result.pendingPlanEffectiveAt
              ? instantDateLabel(result.pendingPlanEffectiveAt, timezone)
              : periodEndLabel
          }`,
        );
        return;
      }
      if (result.clientSecret === null) {
        finish('Membership updated');
        return;
      }
      setClientSecret(result.clientSecret);
      await payProration(result.clientSecret);
    },
    [busy, change, finish, payProration, periodEndLabel, timezone],
  );

  // No changeable/cancellable membership at all.
  if (!currentPlan || (!canChange && !canCancel)) {
    return (
      <AccountFrame title="Change membership" backLabel="Back to billing" backTo="/account/billing">
        <EmptyStateView
          title="No active membership to change"
          description="You do not have a membership that can be changed or cancelled right now."
        />
      </AccountFrame>
    );
  }

  // ── Payment step (proration charge for an upgrade) ──
  const inPaymentStep = clientSecret !== null || payPhase === 'processing' || confirm.isPending;
  if (inPaymentStep) {
    const selectedPlan = plans.find((plan) => plan.id === selectedPlanId) ?? null;
    return (
      <AccountFrame title="Change membership" backLabel="Back to billing" backTo="/account/billing">
        {payPhase === 'processing' ? (
          <View style={styles.panel} accessibilityRole="progressbar">
            {payNotice ? (
              <Text style={styles.payAlert} accessibilityRole="alert">
                {payNotice}
              </Text>
            ) : null}
            <Text style={styles.panelTitle}>Your payment is processing</Text>
            <Text style={styles.panelBody}>
              Your plan change completes as soon as the charge clears. This can take a moment for some
              payment methods.
            </Text>
            <PrimaryButton
              label="Check again"
              loading={confirm.isPending}
              onPress={() => void runConfirm()}
            />
          </View>
        ) : (
          <View style={styles.panel}>
            <Text style={styles.panelBody}>
              Confirm the prorated charge to finish switching to {selectedPlan?.name ?? 'your new plan'}.
            </Text>
            {payNotice ? (
              <Text style={styles.payAlert} accessibilityRole="alert">
                {payNotice}
              </Text>
            ) : null}
            <PrimaryButton
              label="Pay and switch plan"
              loading={payPhase === 'paying'}
              onPress={() => {
                if (clientSecret) void payProration(clientSecret);
              }}
            />
            <PrimaryButton
              label="Back to billing"
              variant="ghost"
              disabled={busy}
              onPress={() => router.replace('/account/billing')}
            />
          </View>
        )}
      </AccountFrame>
    );
  }

  // ── Plan picker ──
  const cards = planCardsForPeriod(plans, period);
  const selectedPlan = cards.find((card) => card.plan.id === selectedPlanId)?.plan ?? null;
  const isCurrent = selectedPlan?.id === currentPlan.id;
  const changeKind: PlanChangeKind | null =
    selectedPlan && !isCurrent
      ? planChangeKind(
          { tier: currentPlan.tier, interval: currentPlan.interval, amountCents: currentPlan.amountCents },
          { tier: selectedPlan.tier, interval: selectedPlan.interval, amountCents: selectedPlan.amountCents },
        )
      : null;

  return (
    <AccountFrame title="Change membership" backLabel="Back to billing" backTo="/account/billing">
      {payNotice ? (
        <Text style={styles.payAlert} accessibilityRole="alert">
          {payNotice}
        </Text>
      ) : null}

      {canChange ? (
        <>
          {periods.length > 1 ? (
            <SegmentedControl
              label="Billing period"
              options={periods.map((value) => ({ value, label: PERIOD_LABELS[value] }))}
              value={period}
              onChange={(next) => {
                setPeriod(next);
                setSelectedPlanId(null);
              }}
            />
          ) : null}

          <View style={styles.cards} accessibilityRole="radiogroup" accessibilityLabel="Membership plans">
            {cards.map((card) => (
              <PlanChoiceCard
                key={card.tier}
                card={card}
                currentPlanId={currentPlan.id}
                scheduledPlanId={membership?.pendingPlan?.id ?? null}
                selected={selectedPlan?.id === card.plan.id}
                onSelect={() => setSelectedPlanId(card.plan.id)}
              />
            ))}
          </View>

          {selectedPlan && !isCurrent && changeKind ? (
            <View style={styles.summaryBox}>
              <Text style={styles.summaryText}>{planChangeSummary(changeKind, periodEndLabel)}</Text>
              {changeKind === 'upgrade' && !configured ? (
                <Text style={styles.hint}>
                  Payments are not configured in this environment, so an upgrade that needs a charge
                  cannot be completed.
                </Text>
              ) : null}
              {changeError ? (
                <Text style={styles.payAlert} accessibilityRole="alert">
                  {changeError}
                </Text>
              ) : null}
              <PrimaryButton
                label={changeKind === 'upgrade' ? 'Switch now' : `Switch on ${periodEndLabel}`}
                loading={busy}
                onPress={() => void onSwitch(selectedPlan.id)}
              />
            </View>
          ) : null}

          {selectedPlan && isCurrent && membership?.pendingPlan ? (
            <View style={styles.summaryBox}>
              <Text style={styles.summaryText}>
                Staying on {currentPlan.name} removes the scheduled switch to{' '}
                {membership.pendingPlan.name}.
              </Text>
              {changeError ? (
                <Text style={styles.payAlert} accessibilityRole="alert">
                  {changeError}
                </Text>
              ) : null}
              <PrimaryButton
                label={`Keep ${currentPlan.name}`}
                loading={busy}
                onPress={() => void onSwitch(currentPlan.id)}
              />
            </View>
          ) : null}
        </>
      ) : (
        <View style={styles.summaryBox}>
          <Text style={styles.summaryText}>
            {membership?.status === 'past_due' || membership?.status === 'unpaid'
              ? 'Your payment is past due, so plan changes are unavailable. Update your payment method on the billing page, or cancel your membership below.'
              : 'Plan changes need an active membership. You can still cancel your membership below.'}
          </Text>
        </View>
      )}

      {/* ── Cancel zone ── */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel membership"
        onPress={() => setCancelOpen(true)}
        hitSlop={8}
        style={styles.cancelZone}
      >
        <Text style={styles.cancelLink}>Cancel membership</Text>
      </Pressable>

      <Sheet
        open={cancelOpen}
        onClose={() => {
          if (!cancel.isPending) setCancelOpen(false);
        }}
        title="Cancel membership"
      >
        <View style={styles.dialog}>
          <Text style={styles.dialogText}>
            {membership?.cancelAtPeriodEnd
              ? `Your membership is already set to end on ${periodEndLabel}. You can still cancel immediately below.`
              : canChange
                ? `Your membership stays active until ${periodEndLabel}, then ends. You will not be charged again.`
                : `Your membership ends on ${periodEndLabel}. You will not be charged again.`}
          </Text>
          <Checkbox
            checked={cancelNow}
            onChange={setCancelNow}
            accessibilityLabel="Cancel immediately instead of at the end of the billing period"
            label={
              <Text style={styles.checkboxLabel}>
                Cancel immediately instead. Access ends now and the remaining time is not refunded.
              </Text>
            }
          />
          <View style={styles.dialogActions}>
            <PrimaryButton
              label={cancelNow ? 'Cancel immediately' : 'Cancel membership'}
              variant="danger"
              loading={cancel.isPending}
              onPress={() =>
                cancel.mutate(
                  { now: cancelNow },
                  {
                    onSuccess: (result) => {
                      setCancelOpen(false);
                      finish(
                        result.canceledImmediately
                          ? 'Your membership has been canceled'
                          : `Your membership ends ${instantDateLabel(result.effectiveAt, timezone)}`,
                      );
                    },
                    onError: () => {
                      setCancelOpen(false);
                      toast({
                        variant: 'error',
                        message: 'We could not cancel your membership. Please try again.',
                      });
                    },
                  },
                )
              }
            />
            <PrimaryButton
              label="Keep membership"
              variant="ghost"
              disabled={cancel.isPending}
              onPress={() => setCancelOpen(false)}
            />
          </View>
        </View>
      </Sheet>
    </AccountFrame>
  );
}

function PlanChoiceCard({
  card,
  currentPlanId,
  scheduledPlanId,
  selected,
  onSelect,
}: {
  card: PlanCard;
  currentPlanId: string;
  scheduledPlanId: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const { plan, locked } = card;
  const isCurrent = plan.id === currentPlanId;
  const isScheduled = plan.id === scheduledPlanId;

  if (locked) {
    return (
      <View
        style={styles.lockedCard}
        accessibilityLabel={`${tierLabel(plan.tier)} membership, invite only`}
      >
        <View style={styles.cardHeader}>
          <Text style={styles.lockedName}>{tierLabel(plan.tier)}</Text>
          <Badge label="Invite only" variant="neutral" />
        </View>
        {plan.features.length > 0 ? (
          <Text style={styles.lockedSummary}>{plan.features.join(' · ')}</Text>
        ) : null}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${tierLabel(plan.tier)} membership, ${formatAmount(plan.amountCents)} ${periodSuffix(plan.interval)}`}
      onPress={onSelect}
      style={[styles.card, selected ? styles.cardSelected : null]}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardName}>{tierLabel(plan.tier)}</Text>
        <View style={styles.cardBadges}>
          {isCurrent ? <Badge label="Current plan" variant="accent" /> : null}
          {isScheduled ? <Badge label="Scheduled" variant="neutral" /> : null}
          {selected ? (
            <View style={styles.checkCircle}>
              <Ionicons name="checkmark" size={16} color={colors.textOnAccent} />
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.priceRow}>
        <Text style={styles.price}>{formatAmount(plan.amountCents)}</Text>
        <Text style={styles.priceSuffix}> {periodSuffix(plan.interval)}</Text>
      </View>
      <Text style={styles.priceCaption}>{billingCaption(plan)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: {
    gap: spacing.md,
  },
  errorBox: {
    gap: spacing.md,
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
  cards: {
    gap: spacing.md,
  },
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceOverlay,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  cardSelected: {
    borderColor: colors.borderActive,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  cardName: {
    ...typography.h2,
    color: colors.text,
  },
  checkCircle: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: spacing.xs,
  },
  price: {
    fontFamily: fonts.displayHeavy,
    fontSize: 40,
    lineHeight: 46,
    color: colors.accent,
  },
  priceSuffix: {
    ...typography.body,
    color: colors.textMuted,
  },
  priceCaption: {
    ...typography.caption,
    color: colors.textSubtle,
  },
  lockedCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundDeep,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  lockedName: {
    ...typography.h2,
    color: colors.textMuted,
  },
  lockedSummary: {
    ...typography.body,
    color: colors.textSubtle,
  },
  summaryBox: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  summaryText: {
    ...typography.body,
    color: colors.text,
  },
  hint: {
    ...typography.caption,
    color: colors.textMuted,
  },
  payAlert: {
    ...typography.body,
    color: colors.danger,
  },
  panel: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  panelTitle: {
    ...typography.h3,
    color: colors.text,
  },
  panelBody: {
    ...typography.body,
    color: colors.textMuted,
  },
  cancelZone: {
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  cancelLink: {
    ...typography.bodyStrong,
    color: colors.danger,
  },
  dialog: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  dialogText: {
    ...typography.body,
    color: colors.text,
  },
  checkboxLabel: {
    flex: 1,
    ...typography.body,
    color: colors.textMuted,
  },
  dialogActions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
