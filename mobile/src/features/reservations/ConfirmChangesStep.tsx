import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  api,
  ApiError,
  type Reservation,
  type ReservationViewer,
  type ResourceTypeSummary,
} from '../../lib/api';
import { usePaymentSheet, usePaymentsConfigured } from '../../lib/stripe';
import { EmptyStateView, PrimaryButton, Skeleton } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import {
  formatAmountWithCents,
  formatDateLong,
  formatTimeRangeCompact,
  resourceNoun,
} from '../reserve/booking';
import {
  classifyReissueError,
  classifyReissueResult,
  isPaymentClearing,
  isTerminalHoldError,
} from '../reserve/booking-failures';
import { ProcessingOverlay } from '../reserve/ProcessingOverlay';
import { ReservationSummaryCard } from '../reserve/ReservationSummaryCard';
import { StepShell } from '../reserve/StepShell';
import { MembershipInactiveState } from '../reserve/MembershipInactiveState';
import { useCountdown } from '../reserve/useCountdown';
import type { HoldSession } from '../reserve/hold-session';
import { describeEditFailure } from './edit-failures';
import {
  describeRescheduleMoney,
  reservationMatchesMove,
  selectionTarget,
  type MoveTarget,
  type RescheduleMoney,
} from './reservation-policy';

type ReservationDetail = Reservation & { viewer: ReservationViewer };

const HOLD_WARNING_SECONDS = 120;

/**
 * Shown when a paid grow settled but the reservation did NOT move: the
 * backend dropped the parked change (lapsed at its TTL, superseded, or the
 * slot was gone at settle time) and auto-refunds the captured delta.
 */
const CHANGE_DROPPED_MESSAGE =
  'We could not apply your change in time. Your original booking is unchanged; if you were charged, the amount is refunded automatically.';

/** The payable parked change: the delta PaymentIntent secret + its TTL. */
interface PayableChange {
  clientSecret: string;
  expiresAt: string | null;
}

export interface ConfirmChangesStepProps {
  detail: ReservationDetail;
  type: ResourceTypeSummary;
  date: string;
  slots: string[];
  holdSession: HoldSession;
  onApplied: (reservation: Reservation, money: RescheduleMoney | null) => void;
  onBackToTime: (message: string | null) => void;
}

/**
 * Edit step 2 (Figma confirm-changes 205:19481): price the move with
 * POST :id/reschedule-quote, show the old -> new booking card and the delta.
 *
 * - shrink / equal: Save applies the move immediately (PATCH) and any
 *   difference is refunded to the card;
 * - grow: the SAME hold-session + payment-lock + reissue money-safety
 *   pattern as M3 checkout collects the delta first. PATCH parks the change
 *   with a fresh PaymentIntent, the native PaymentSheet collects the delta,
 *   and POST :id/confirm applies the move. Nothing moves (and nothing is
 *   kept) on an unpaid change; a failed sheet reissues the intent and only
 *   the proven-unpaid outcome clears the lock (see booking-failures).
 */
export function ConfirmChangesStep({
  detail,
  type,
  date,
  slots,
  holdSession,
  onApplied,
  onBackToTime,
}: ConfirmChangesStepProps) {
  const paymentsConfigured = usePaymentsConfigured();
  const presentPayment = usePaymentSheet();
  const noun = resourceNoun(detail.typeName);

  // Step 2 is only reachable with a non-empty, changed selection.
  const target = selectionTarget(date, slots, type.slotDurationMinutes)!;

  const quote = useQuery({
    queryKey: ['reschedule-quote', detail.id, date, slots],
    queryFn: () => api.rescheduleQuote(detail.id, { date, slots }),
  });
  const money = quote.data ? describeRescheduleMoney(quote.data) : null;

  // The immediate path (shrink / equal): PATCH applies the move on Save.
  const save = useMutation({
    mutationFn: () => api.rescheduleReservation(detail.id, { date, slots }),
    onSuccess: (result) => onApplied(result.reservation, money),
  });

  // The grow path: PATCH up front to park the change and mint the delta
  // PaymentIntent (mirroring checkout, which holds on entry). The attempt
  // token keeps the ledger honest if the member backs out while the PATCH is
  // in flight; a superseded parked change lapses or is dropped server-side.
  const park = useMutation({
    mutationFn: async () => {
      const attempt = holdSession.beginAttempt();
      const result = await api.rescheduleReservation(detail.id, { date, slots });
      holdSession.holdCreated(detail.id, attempt);
      return result;
    },
    onSuccess: (result) => {
      if (result.clientSecret) {
        setHeld({
          clientSecret: result.clientSecret,
          expiresAt: result.reservation.pendingChange?.expiresAt ?? null,
        });
      }
    },
  });
  const parked = park.data ?? null;

  const confirm = useMutation({ mutationFn: () => api.confirmReservation(detail.id) });

  /** The live payable change; reissue can swap its secret + TTL in place. */
  const [held, setHeld] = useState<PayableChange | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [processingHold, setProcessingHold] = useState(false);
  const [changeExpired, setChangeExpired] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  // Set when a reissue could not prove the previous charge did NOT capture
  // (network / 5xx, or an unexpected response). The payment lock STAYS ON and
  // the member re-runs the reissue; see recoverFromDecline.
  const [recoverError, setRecoverError] = useState<string | null>(null);

  // Park the change as soon as the quote proves a grow (mirroring checkout,
  // which holds the slot on entry). Fired once.
  const startedRef = useRef(false);
  const parkMutate = park.mutate;
  const growCents = money?.kind === 'charge' ? money.dueTodayCents : null;
  useEffect(() => {
    if (!paymentsConfigured || growCents === null || startedRef.current) return;
    startedRef.current = true;
    parkMutate();
  }, [paymentsConfigured, growCents, parkMutate]);

  // A parked "grow" the backend resolved as shrink/equal applies at once.
  const parkedApplied = parked !== null && parked.clientSecret === null;
  const appliedFiredRef = useRef(false);
  useEffect(() => {
    if (!parkedApplied || !parked || appliedFiredRef.current) return;
    appliedFiredRef.current = true;
    holdSession.settle();
    onApplied(parked.reservation, null);
  }, [parkedApplied, parked, holdSession, onApplied]);

  const changeSecondsLeft = useCountdown(held?.expiresAt ?? null);
  const countdownLapsed = changeSecondsLeft !== null && changeSecondsLeft <= 0;
  const showChangeExpired =
    changeExpired ||
    (countdownLapsed &&
      !paying &&
      !confirming &&
      !confirmError &&
      !processingHold &&
      !recovering &&
      !recoverError);

  async function handlePaid() {
    setConfirmError(false);
    setConfirming(true);
    try {
      const reservation = await confirm.mutateAsync();
      setConfirming(false);
      // "The pending change is gone" is NOT proof the move applied (a dropped
      // change also clears it); only the reservation actually sitting on the
      // requested date AND time counts as success.
      if (!reservation.pendingChange && reservationMatchesMove(reservation, target)) {
        onApplied(reservation, money);
        return;
      }
      // The change was swept before the payment settled it; any captured delta
      // is refunded by the backend's orphan path.
      onBackToTime(CHANGE_DROPPED_MESSAGE);
    } catch (err) {
      setConfirming(false);
      if (isPaymentClearing(err)) {
        // The charge reached Stripe but has not cleared: re-check, never retry
        // a payment that could double-charge.
        setProcessingHold(true);
        return;
      }
      if (err instanceof ApiError && err.code === 'SLOT_UNAVAILABLE') {
        onBackToTime(
          'That time was taken while you paid. Your original booking is unchanged and the charge is refunded automatically.',
        );
        return;
      }
      if (err instanceof ApiError && err.code === 'INVALID_STATUS') {
        onBackToTime('This reservation changed while you were editing it.');
        return;
      }
      // Money captured but confirm failed: keep the lock and let them retry.
      setConfirmError(true);
    }
  }

  /**
   * Recover a parked change after a failed PaymentSheet result by reissuing
   * its delta PaymentIntent. The money-safety invariant is the same as
   * checkout (see classifyReissue* + hold-session.ts): the payment lock is
   * cleared ONLY on a proven-unpaid outcome (a fresh secret minted after the
   * old intent was retired at Stripe). A captured charge, a gone change, and
   * every indeterminate failure all KEEP the lock on.
   */
  async function recoverFromDecline(message: string | null) {
    setRecovering(true);
    const disposition = await api
      .reissuePaymentIntent(detail.id)
      .then(classifyReissueResult, classifyReissueError);
    setRecovering(false);

    switch (disposition.kind) {
      case 'paid':
        setRecoverError(null);
        holdSession.setPaymentLocked(true);
        await handlePaid();
        return;
      case 'retry-in-place':
        setRecoverError(null);
        setHeld({ clientSecret: disposition.clientSecret, expiresAt: disposition.expiresAt });
        holdSession.setPaymentLocked(false);
        setPayError(message ?? 'Your payment could not be completed. Try again.');
        return;
      case 'expired':
        // The parked change is gone server-side; KEEP the lock so the
        // follow-on navigation releases without a client cancel.
        setRecoverError(null);
        setChangeExpired(true);
        return;
      case 'recover':
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
    // From here the delta may capture at Stripe: freeze the chrome until the
    // payment is known to have failed.
    holdSession.setPaymentLocked(true);
    let result;
    try {
      result = await presentPayment({ clientSecret: held.clientSecret });
    } catch {
      result = { status: 'failed', message: 'Payment failed. Please try again.' } as const;
    }
    setPaying(false);

    if (result.status === 'unconfigured') {
      holdSession.setPaymentLocked(false);
      setPayError('Payments are not configured in this environment.');
      return;
    }
    if (result.status === 'canceled') {
      // Dismissed before paying: nothing captured, the change is still parked.
      holdSession.setPaymentLocked(false);
      return;
    }
    if (result.status === 'failed') {
      await recoverFromDecline(result.message ?? null);
      return;
    }
    await handlePaid();
  }

  // ── Failure states from quote / PATCH ──

  const failure = describeEditFailure(quote.error ?? save.error ?? park.error);
  if (failure) {
    if (failure.kind === 'membership') {
      return (
        <StepShell title="Confirm changes" subtitle="Confirm to update your reservation">
          <MembershipInactiveState />
        </StepShell>
      );
    }
    if (failure.kind === 'back-to-time') {
      return (
        <StepShell title="Confirm changes" subtitle="Confirm to update your reservation">
          <NoticeBox message={failure.message}>
            <PrimaryButton label="Pick another time" onPress={() => onBackToTime(null)} />
          </NoticeBox>
        </StepShell>
      );
    }
    return (
      <StepShell title="Confirm changes" subtitle="Confirm to update your reservation">
        <NoticeBox message={failure.message}>
          <PrimaryButton
            label="Try again"
            variant="secondary"
            onPress={() => {
              save.reset();
              park.reset();
              startedRef.current = false;
              void quote.refetch();
            }}
          />
        </NoticeBox>
      </StepShell>
    );
  }

  if (showChangeExpired) {
    return (
      <StepShell title="Confirm changes" subtitle="Confirm to update your reservation">
        <NoticeBox message="Your change request expired before the payment completed. Nothing was changed.">
          <PrimaryButton label="Choose a new time" onPress={() => onBackToTime(null)} />
        </NoticeBox>
      </StepShell>
    );
  }

  if (processingHold) {
    return (
      <StepShell title="Confirm changes" subtitle="Confirm to update your reservation">
        <NoticeBox
          title="Your payment is processing"
          message="Your new time will be confirmed as soon as the payment clears. This can take a moment for some payment methods."
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
      <StepShell title="Confirm changes" subtitle="Confirm to update your reservation">
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

  if (quote.isPending) {
    return (
      <StepShell title="Confirm changes" subtitle="Confirm to update your reservation">
        <View style={styles.loading} accessibilityLabel="Pricing your change">
          <Skeleton height={150} borderRadius={radius.lg} />
          <Skeleton height={160} borderRadius={radius.lg} />
        </View>
      </StepShell>
    );
  }

  const summary = (
    <>
      <ChangeSummaryCard detail={detail} target={target} />
      <EditOrderSummary noun={noun} detail={detail} durationMinutes={quote.data!.durationMinutes} money={money!} />
    </>
  );

  // ── Shrink / equal: Save applies immediately ──

  if (money!.kind !== 'charge') {
    return (
      <StepShell
        title="Confirm changes"
        subtitle="Confirm to update your reservation"
        footer={
          <PrimaryButton label="Save changes" loading={save.isPending} onPress={() => save.mutate()} />
        }
      >
        {summary}
        {money!.kind === 'refund' ? (
          <Text style={styles.refundHint}>
            The difference is refunded to the card you paid with; no payment is needed today.
          </Text>
        ) : null}
      </StepShell>
    );
  }

  // ── Grow: collect the delta with the shared PaymentSheet money-safety ──

  if (!paymentsConfigured) {
    return (
      <StepShell title="Confirm changes" subtitle="Confirm to update your reservation">
        <EmptyStateView
          title="Payments are not configured"
          description="Set EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY to enable payments in this build."
        />
      </StepShell>
    );
  }

  if (park.isPending || !parked || parkedApplied || !held?.clientSecret) {
    return (
      <StepShell title="Confirm changes" subtitle="Confirm to update your reservation">
        <View style={styles.loading} accessibilityLabel="Preparing your payment">
          <Skeleton height={150} borderRadius={radius.lg} />
          <Skeleton height={160} borderRadius={radius.lg} />
          <Skeleton height={46} borderRadius={radius.pill} />
        </View>
      </StepShell>
    );
  }

  return (
    <StepShell
      title="Confirm changes"
      subtitle="Confirm to update your reservation"
      footer={
        <PrimaryButton
          label={`Save changes · ${formatAmountWithCents(money!.dueTodayCents)}`}
          loading={paying || confirming || recovering}
          onPress={() => void pay()}
        />
      }
    >
      {summary}

      {changeSecondsLeft !== null ? (
        <View style={styles.holdHint} accessibilityLabel={holdAnnouncement(changeSecondsLeft)}>
          <Ionicons
            name="time-outline"
            size={16}
            color={changeSecondsLeft <= HOLD_WARNING_SECONDS ? colors.dangerStrong : colors.textMuted}
          />
          <Text style={styles.holdHintText}>
            Your new time is held for{' '}
            <Text style={styles.holdHintStrong}>{formatCountdown(changeSecondsLeft)}</Text>
          </Text>
        </View>
      ) : null}

      {payError ? (
        <Text accessibilityRole="alert" style={styles.payError}>
          {payError}
        </Text>
      ) : null}

      {confirmError ? (
        <NoticeBox message="Your payment went through, but we could not update your booking. Retry; you will not be charged twice.">
          <PrimaryButton
            label="Try again"
            variant="secondary"
            loading={confirm.isPending}
            onPress={() => void handlePaid()}
          />
        </NoticeBox>
      ) : null}

      <ProcessingOverlay
        visible={confirming}
        noun={noun}
        title="Updating your booking..."
        body="We're moving your reservation to its new time"
      />
    </StepShell>
  );
}

/** The booking card with old -> new date/time rows (Figma 205:19481). */
function ChangeSummaryCard({ detail, target }: { detail: Reservation; target: MoveTarget }) {
  const dateChanged = target.date !== detail.date;
  const oldRange = formatTimeRangeCompact(detail.startTime, detail.endTime);
  const newRange = formatTimeRangeCompact(target.startTime, target.endTime);
  // Time changes on its own merits: a date-only move must not strike through
  // (and re-print) an identical time range.
  const timeChanged = oldRange !== newRange;

  return (
    <ReservationSummaryCard
      typeCode={detail.typeCode}
      typeName={detail.typeName}
      resourceName={detail.resource.name}
      rows={[]}
    >
      <View style={styles.changeRows}>
        <View style={styles.changeRow}>
          <Ionicons name="calendar-outline" size={16} color={colors.textMuted} />
          {dateChanged ? (
            <Text style={styles.changeText} accessibilityLabel={`Date changed from ${formatDateLong(detail.date)} to ${formatDateLong(target.date)}`}>
              <Text style={styles.changeOld}>{formatDateLong(detail.date)}</Text>
              {'  →  '}
              <Text>{formatDateLong(target.date)}</Text>
            </Text>
          ) : (
            <Text style={styles.changeText}>{formatDateLong(target.date)}</Text>
          )}
        </View>
        <View style={styles.changeRow}>
          <Ionicons name="time-outline" size={16} color={colors.textMuted} />
          {timeChanged ? (
            <Text style={styles.changeText} accessibilityLabel={`Time changed from ${oldRange} to ${newRange}`}>
              <Text style={styles.changeOld}>{oldRange}</Text>
              {'  →  '}
              <Text>{newRange}</Text>
            </Text>
          ) : (
            <Text style={styles.changeText}>{newRange}</Text>
          )}
        </View>
      </View>
    </ReservationSummaryCard>
  );
}

/** ORDER SUMMARY with the reschedule delta (Figma 205:19481). */
function EditOrderSummary({
  noun,
  detail,
  durationMinutes,
  money,
}: {
  noun: string;
  detail: Reservation;
  durationMinutes: number;
  money: RescheduleMoney;
}) {
  const hours = durationMinutes / 60;
  const hoursLabel = hours === 1 ? '1 hour' : `${hours} hours`;
  const feeLabel = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} fee`;

  return (
    <View style={styles.orderSummary}>
      <Text style={styles.orderTitle}>Order summary</Text>
      <View style={styles.orderRow}>
        <Text style={styles.orderLabel}>{feeLabel}</Text>
        <Text style={styles.orderRate}>
          {formatAmountWithCents(detail.hourlyRateCents)} / hour{'\n'}
          <Text style={styles.orderRateSub}>x {hoursLabel}</Text>
        </Text>
      </View>
      {money.netPaidCents > 0 ? (
        <View style={styles.orderRow}>
          <Text style={styles.orderLabel}>Previous payment</Text>
          <Text style={styles.orderRate}>- {formatAmountWithCents(money.netPaidCents)}</Text>
        </View>
      ) : null}
      <View style={styles.orderDivider} />
      <View style={styles.orderRow}>
        <Text style={styles.orderTotalLabel}>Total due today</Text>
        <Text style={styles.orderTotal}>{formatAmountWithCents(money.dueTodayCents)}</Text>
      </View>
      {money.kind === 'refund' ? (
        <Text style={styles.orderNote}>
          * You will be refunded {formatAmountWithCents(money.refundCents)} to the account on file
        </Text>
      ) : null}
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

function holdAnnouncement(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'Your change request expired';
  if (secondsLeft <= HOLD_WARNING_SECONDS)
    return 'Your new time is held for less than two minutes. Finish paying to keep it.';
  return 'Your new time is held while you complete payment.';
}

const styles = StyleSheet.create({
  loading: {
    gap: spacing.md,
  },
  changeRows: {
    gap: spacing.sm,
  },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  changeText: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  },
  changeOld: {
    color: colors.textSubtle,
    textDecorationLine: 'line-through',
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
  orderNote: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 16,
  },
  refundHint: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
  },
  holdHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
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
