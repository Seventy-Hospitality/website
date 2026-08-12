import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  api,
  type CreateReservationResult,
  type Reservation,
  type ResourceTypeSummary,
} from '../../lib/api';
import { usePaymentSheet, usePaymentsConfigured } from '../../lib/stripe';
import { EmptyStateView, PrimaryButton, Skeleton } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import {
  formatAmount,
  formatAmountWithCents,
  formatDateLong,
  formatDuration,
  formatTimeRangeCompact,
  resourceFeeLabel,
  resourceNoun,
  selectionSummary,
} from './booking';
import {
  classifyReissueError,
  classifyReissueResult,
  describeBookingFailure,
  isPaymentClearing,
  isTerminalHoldError,
} from './booking-failures';
import { inviteesPayload, type InviteSelection } from './invites';
import { MembershipInactiveState } from './MembershipInactiveState';
import { ProcessingOverlay } from './ProcessingOverlay';
import { ReservationSummaryCard } from './ReservationSummaryCard';
import { StepShell } from './StepShell';
import { useCountdown } from './useCountdown';

const HOLD_WARNING_SECONDS = 120;

export interface CheckoutStepProps {
  type: ResourceTypeSummary;
  date: string;
  slots: string[];
  invites: InviteSelection;
  /** Names a create attempt so the wizard can tell live holds from orphans. */
  beginHoldAttempt: () => number;
  onHoldCreated: (reservationId: string, attempt: number) => void;
  /** True from payment submit until the charge is known NOT captured. */
  onPaymentLock: (locked: boolean) => void;
  onConfirmed: (reservation: Reservation) => void;
  /** Slot taken / hold expired: release and return to the time step. */
  onPickAnotherTime: (message: string | null) => void;
}

/**
 * Wizard step 3 (Figma checkout 14:582): the backend hold/pay/confirm
 * contract, native PaymentSheet edition.
 *
 *  1. POST /api/reservations/quote prices the selection server-side.
 *  2. POST /api/reservations HOLDS the slot (pending_payment, ~12 min TTL),
 *     assigns a specific court (revealed here) and returns a PaymentIntent
 *     client secret.
 *  3. The native PaymentSheet collects and confirms the card on that secret.
 *  4. POST /api/reservations/:id/confirm asserts the payment captured and
 *     flips the hold to confirmed ("securing your spot").
 *
 * The Figma-omitted states are handled here: the slot taken between select
 * and hold (409 SLOT_UNAVAILABLE -> back to time), the hold expiring before
 * payment (countdown + 409 HOLD_EXPIRED), the charge still clearing
 * (402 PAYMENT_REQUIRED -> re-check), and a declined/failed payment (mint a
 * FRESH PaymentIntent on the same hold via reissue and retry in place, never
 * a second charge; `alreadyPaid` settles to confirm instead).
 */
export function CheckoutStep({
  type,
  date,
  slots,
  invites,
  beginHoldAttempt,
  onHoldCreated,
  onPaymentLock,
  onConfirmed,
  onPickAnotherTime,
}: CheckoutStepProps) {
  const paymentsConfigured = usePaymentsConfigured();
  const presentPayment = usePaymentSheet();

  const quote = useQuery({
    queryKey: ['booking-quote', type.code, date, slots],
    queryFn: () => api.quoteReservation({ typeCode: type.code, date, slots }),
    enabled: paymentsConfigured,
  });

  const create = useMutation({
    // The hold is reported from inside mutationFn, not onSuccess: the request
    // outlives this step if the member backs out mid-flight, and the wizard
    // must learn about the hold to release it either way. The attempt token
    // lets the wizard tell a live hold from an orphan to cancel.
    mutationFn: async (input: Parameters<typeof api.createReservation>[0]) => {
      const attempt = beginHoldAttempt();
      const result = await api.createReservation(input);
      onHoldCreated(result.reservation.id, attempt);
      return result;
    },
    onSuccess: (result) => setHeld(result),
  });

  const confirm = useMutation({ mutationFn: api.confirmReservation });

  /** The live hold. Reissue can swap its payable secret + TTL in place. */
  const [held, setHeld] = useState<CreateReservationResult | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [processingHold, setProcessingHold] = useState(false);
  const [holdExpired, setHoldExpired] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  // Set when a reissue could not prove the previous charge did NOT capture
  // (network / 5xx, or an unexpected response). The payment lock STAYS ON and
  // the member re-runs the reissue; see recoverFromDecline.
  const [recoverError, setRecoverError] = useState<string | null>(null);

  // Hold the slot as soon as the server quote lands (the Figma checkout is
  // entered with the court already assigned). Fired once.
  const startedRef = useRef(false);
  const createMutate = create.mutate;
  useEffect(() => {
    if (!paymentsConfigured || !quote.isSuccess || startedRef.current) return;
    startedRef.current = true;
    createMutate({ typeCode: type.code, date, slots, invitees: inviteesPayload(invites) });
  }, [paymentsConfigured, quote.isSuccess, createMutate, type.code, date, slots, invites]);

  const holdSecondsLeft = useCountdown(held?.holdExpiresAt ?? null);
  const countdownLapsed = holdSecondsLeft !== null && holdSecondsLeft <= 0;
  const showHoldExpired =
    holdExpired ||
    (countdownLapsed &&
      !paying &&
      !confirming &&
      !confirmError &&
      !processingHold &&
      !recovering &&
      !recoverError);

  async function handlePaid() {
    if (!held) return;
    setConfirmError(false);
    setConfirming(true);
    try {
      const reservation = await confirm.mutateAsync(held.reservation.id);
      // Stay locked; the parent settles the hold and navigates.
      onConfirmed(reservation);
    } catch (err) {
      setConfirming(false);
      if (isPaymentClearing(err)) {
        // The charge reached Stripe but has not cleared: re-check, do not
        // retry a payment that could double-charge.
        setProcessingHold(true);
        return;
      }
      if (isTerminalHoldError(err)) {
        setHoldExpired(true);
        return;
      }
      // Money captured but confirm failed: keep the lock and let them retry.
      setConfirmError(true);
    }
  }

  /**
   * Recover a hold after a failed PaymentSheet result by reissuing its
   * PaymentIntent. The native sheet cannot tell a definitive decline from an
   * ambiguous failure (a network drop AFTER the charge confirmed), so the
   * capture state is unknown until the backend reissue resolves it.
   *
   * Money-safety invariant (see classifyReissue* + hold-session.ts): the
   * payment lock is cleared ONLY on a proven-unpaid outcome — a fresh secret
   * minted after the old intent was retired at Stripe. A captured charge, a
   * gone hold, and every indeterminate failure all KEEP the lock on, because
   * a client cancel of a possibly-paid hold settles at the cancellation
   * percent (0% within 2h of start) and loses the money.
   */
  async function recoverFromDecline(message: string | null) {
    if (!held) return;
    setRecovering(true);
    const disposition = await api
      .reissuePaymentIntent(held.reservation.id)
      .then(classifyReissueResult, classifyReissueError);
    setRecovering(false);

    switch (disposition.kind) {
      case 'paid':
        // The charge actually captured despite the failure signal: keep the
        // lock and settle the hold to a confirmed booking.
        setRecoverError(null);
        onPaymentLock(true);
        await handlePaid();
        return;
      case 'retry-in-place':
        // Fresh PaymentIntent on the SAME hold: the old intent was PROVABLY
        // retired at Stripe, so nothing captured. Safe to clear the lock and
        // let the member retry in place on the fresh secret.
        setRecoverError(null);
        setHeld((prev) =>
          prev
            ? {
                ...prev,
                clientSecret: disposition.clientSecret,
                holdExpiresAt: disposition.expiresAt,
              }
            : prev,
        );
        onPaymentLock(false);
        setPayError(message ?? 'Your payment could not be completed. Try again.');
        return;
      case 'expired':
        // The hold is gone server-side; the paid-but-expired sweeper owns any
        // captured charge. KEEP the lock so showHoldExpired -> onPickAnotherTime
        // releases WITHOUT cancelling (a client cancel would settle at the
        // policy percent).
        setRecoverError(null);
        setHoldExpired(true);
        return;
      case 'recover':
        // Indeterminate: the original charge state is unknown. The lock STAYS
        // ON and the member re-runs the reissue, which settles a captured
        // charge or mints a fresh secret once the service is reachable.
        setRecoverError(
          'We could not reach the payment service to finish checking your payment. Check your connection and try again.',
        );
        return;
    }
  }

  async function pay() {
    if (!held?.clientSecret || paying || recovering) return;
    setPayError(null);
    setPaying(true);
    // From here the charge may capture at Stripe: the wizard must not let
    // Back/Close cancel the hold until the payment is known to have failed.
    onPaymentLock(true);
    let result;
    try {
      result = await presentPayment({ clientSecret: held.clientSecret });
    } catch {
      result = { status: 'failed', message: 'Payment failed. Please try again.' } as const;
    }
    setPaying(false);

    if (result.status === 'unconfigured') {
      onPaymentLock(false);
      setPayError('Payments are not configured in this environment.');
      return;
    }
    if (result.status === 'canceled') {
      // The member dismissed the sheet before paying: nothing captured, the
      // hold is still live, so backing out may release it again.
      onPaymentLock(false);
      return;
    }
    if (result.status === 'failed') {
      await recoverFromDecline(result.message ?? null);
      return;
    }
    await handlePaid();
  }

  const noun = resourceNoun(type.name);
  const subtitle = 'Confirm & pay to reserve your spot';

  // ── Frame-level states ──

  if (!paymentsConfigured) {
    return (
      <StepShell title="Checkout" subtitle={subtitle}>
        <EmptyStateView
          title="Payments are not configured"
          description="Set EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY to enable checkout in this build."
        />
      </StepShell>
    );
  }

  const failure = describeBookingFailure(quote.error ?? create.error);
  if (failure) {
    if (failure.kind === 'membership') {
      return (
        <StepShell title="Checkout" subtitle={subtitle}>
          <MembershipInactiveState />
        </StepShell>
      );
    }
    if (failure.kind === 'back-to-time') {
      return (
        <StepShell title="Checkout" subtitle={subtitle}>
          <NoticeBox message={failure.message}>
            <PrimaryButton label="Pick another time" onPress={() => onPickAnotherTime(null)} />
          </NoticeBox>
        </StepShell>
      );
    }
    return (
      <StepShell title="Checkout" subtitle={subtitle}>
        <NoticeBox message={failure.message}>
          <PrimaryButton
            label="Try again"
            variant="secondary"
            onPress={() => {
              if (quote.isError) {
                void quote.refetch();
              } else {
                startedRef.current = true;
                create.mutate({
                  typeCode: type.code,
                  date,
                  slots,
                  invitees: inviteesPayload(invites),
                });
              }
            }}
          />
        </NoticeBox>
      </StepShell>
    );
  }

  if (showHoldExpired) {
    return (
      <StepShell title="Checkout" subtitle={subtitle}>
        <NoticeBox
          message={`Your ${noun} hold expired before the payment completed. If you were charged, the amount is refunded automatically.`}
        >
          <PrimaryButton label="Choose a new time" onPress={() => onPickAnotherTime(null)} />
        </NoticeBox>
      </StepShell>
    );
  }

  if (processingHold) {
    return (
      <StepShell title="Checkout" subtitle={subtitle}>
        <NoticeBox
          title="Your payment is processing"
          message="Your booking will be confirmed as soon as the payment clears. This can take a moment for some payment methods."
        >
          <PrimaryButton
            label="Check again"
            variant="secondary"
            loading={confirm.isPending}
            onPress={() => void handlePaid()}
          />
        </NoticeBox>
      </StepShell>
    );
  }

  if (recoverError) {
    return (
      <StepShell title="Checkout" subtitle={subtitle}>
        <NoticeBox title="We couldn't finish your payment" message={recoverError}>
          <PrimaryButton
            label="Try again"
            variant="secondary"
            loading={recovering}
            onPress={() => void recoverFromDecline(null)}
          />
        </NoticeBox>
      </StepShell>
    );
  }

  if (quote.isPending || create.isPending || (quote.isSuccess && !held)) {
    return (
      <StepShell title="Checkout" subtitle={subtitle}>
        <View style={styles.loading} accessibilityLabel="Preparing your booking">
          <Skeleton height={132} borderRadius={radius.lg} />
          <Skeleton height={96} borderRadius={radius.lg} />
          <Skeleton height={46} borderRadius={radius.pill} />
        </View>
      </StepShell>
    );
  }

  if (!held || !held.clientSecret) {
    return (
      <StepShell title="Checkout" subtitle={subtitle}>
        <NoticeBox message="We could not start your payment. The held time was released.">
          <PrimaryButton
            label="Back to time selection"
            variant="secondary"
            onPress={() => onPickAnotherTime(null)}
          />
        </NoticeBox>
      </StepShell>
    );
  }

  // ── The payable checkout ──

  const reservation = held.reservation;
  const summary = selectionSummary(slots, type.slotDurationMinutes, type.hourlyRateCents);
  const hourlyRateCents = quote.data?.hourlyRateCents ?? type.hourlyRateCents;
  const durationMinutes = quote.data?.durationMinutes ?? summary?.durationMinutes ?? 0;

  return (
    <StepShell
      title="Checkout"
      subtitle={subtitle}
      footer={
        <PrimaryButton
          label={`Confirm & pay ${formatAmountWithCents(held.totalCents)}`}
          loading={paying || confirming || recovering}
          onPress={() => void pay()}
        />
      }
    >
      <ReservationSummaryCard
        typeCode={reservation.typeCode}
        typeName={reservation.typeName}
        resourceName={reservation.resource.name}
        rows={[
          { label: 'Date', value: formatDateLong(reservation.date) },
          {
            label: 'Time',
            value: formatTimeRangeCompact(reservation.startTime, reservation.endTime),
          },
          { label: 'Duration', value: formatDuration(reservation.durationMinutes) },
        ]}
      />

      <OrderSummary
        feeLabel={resourceFeeLabel(type.name)}
        hourlyRateCents={hourlyRateCents}
        durationMinutes={durationMinutes}
        totalCents={held.totalCents}
      />

      {holdSecondsLeft !== null ? (
        <View
          style={[styles.holdHint, holdSecondsLeft <= HOLD_WARNING_SECONDS ? styles.holdHintUrgent : null]}
          accessibilityLabel={holdAnnouncement(reservation.resource.name, holdSecondsLeft)}
        >
          <Ionicons
            name="time-outline"
            size={16}
            color={holdSecondsLeft <= HOLD_WARNING_SECONDS ? colors.dangerStrong : colors.textMuted}
          />
          <Text style={styles.holdHintText}>
            {reservation.resource.name} is held for you for{' '}
            <Text style={styles.holdHintStrong}>{formatCountdown(holdSecondsLeft)}</Text>
          </Text>
        </View>
      ) : null}

      {payError ? (
        <Text accessibilityRole="alert" style={styles.payError}>
          {payError}
        </Text>
      ) : null}

      {confirmError ? (
        <NoticeBox message="Your payment went through, but we could not confirm your booking. Retry; you will not be charged twice.">
          <PrimaryButton
            label="Try again"
            variant="secondary"
            loading={confirm.isPending}
            onPress={() => void handlePaid()}
          />
        </NoticeBox>
      ) : null}

      <ProcessingOverlay visible={confirming} resourceName={reservation.resource.name} noun={noun} />
    </StepShell>
  );
}

function OrderSummary({
  feeLabel,
  hourlyRateCents,
  durationMinutes,
  totalCents,
}: {
  feeLabel: string;
  hourlyRateCents: number;
  durationMinutes: number;
  totalCents: number;
}) {
  const hours = durationMinutes / 60;
  const hoursLabel = hours === 1 ? '1 hour' : `${hours} hours`;
  return (
    <View style={styles.orderSummary}>
      <Text style={styles.orderTitle}>Order summary</Text>
      <View style={styles.orderRow}>
        <Text style={styles.orderLabel}>{feeLabel}</Text>
        <Text style={styles.orderRate}>
          {formatAmount(hourlyRateCents)} / hour{'\n'}
          <Text style={styles.orderRateSub}>x {hoursLabel}</Text>
        </Text>
      </View>
      <View style={styles.orderDivider} />
      <View style={styles.orderRow}>
        <Text style={styles.orderTotalLabel}>Total due today</Text>
        <Text style={styles.orderTotal}>{formatAmountWithCents(totalCents)}</Text>
      </View>
    </View>
  );
}

function NoticeBox({
  title,
  message,
  children,
}: {
  title?: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.noticeBox} accessibilityRole="alert">
      {title ? <Text style={styles.noticeTitle}>{title}</Text> : null}
      <Text style={styles.noticeText}>{message}</Text>
      {children}
    </View>
  );
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function holdAnnouncement(resourceName: string, secondsLeft: number): string {
  if (secondsLeft <= 0) return `${resourceName} hold expired`;
  if (secondsLeft <= 60) return `${resourceName} is held for less than a minute. Finish paying to keep it.`;
  if (secondsLeft <= HOLD_WARNING_SECONDS)
    return `${resourceName} is held for less than two minutes. Finish paying to keep it.`;
  return `${resourceName} is held for you while you complete payment.`;
}

const styles = StyleSheet.create({
  loading: {
    gap: spacing.md,
  },
  orderSummary: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  orderTitle: {
    color: colors.text,
    fontFamily: fonts.displaySemibold,
    fontSize: 16,
  },
  orderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  orderLabel: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  orderRate: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    textAlign: 'right',
  },
  orderRateSub: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 12,
  },
  orderDivider: {
    height: 1,
    backgroundColor: colors.border,
  },
  orderTotalLabel: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
  },
  orderTotal: {
    color: colors.accent,
    fontFamily: fonts.displayBold,
    fontSize: 18,
  },
  holdHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  holdHintUrgent: {},
  holdHintText: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  holdHintStrong: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
  },
  payError: {
    color: colors.danger,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  noticeBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  noticeTitle: {
    color: colors.text,
    fontFamily: fonts.displaySemibold,
    fontSize: 16,
  },
  noticeText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 19,
  },
});
