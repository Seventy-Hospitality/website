import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CalendarDays, Clock, SearchX, X } from 'lucide-react';
import {
  api,
  ApiError,
  type Reservation,
  type ReservationViewer,
  type ResourceTypeSummary,
} from '../../lib/api';
import {
  bookingRefLabel,
  formatDateFull,
  formatDateLong,
  formatTimeRangeCompact,
  resourceNoun,
} from '../../lib/booking';
import { formatAmountWithCents } from '../../lib/plan-pricing';
import { memberDisplayName } from '../../lib/invites';
import {
  describeRescheduleMoney,
  hasReservationStarted,
  isSelectionChanged,
  reservationMatchesMove,
  reservationSlots,
  selectionTarget,
  type MoveTarget,
  type RescheduleMoney,
} from '../../lib/reservation-policy';
import { getStripe } from '../../lib/stripe';
import { StripeProvider } from '../../lib/StripeProvider';
import {
  Avatar,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  FullScreenLoader,
  ReservationCard,
  Sheet,
  Skeleton,
} from '../../components';
import { isEntitledMembershipStatus, resourceTypesQuery, reservationQuery } from '../reserve/booking-data';
import { createHoldSession, type HoldSession } from '../reserve/hold-session';
import { MembershipInactiveState } from '../reserve/MembershipInactiveState';
import { SelectTimeStep } from '../reserve/SelectTimeStep';
import { BookingPaymentForm, ProcessingScreen } from '../reserve/CheckoutStep';
import { useCountdown } from '../reserve/use-countdown';
import { membershipQuery } from '../onboarding/onboarding-data';
import wizard from '../reserve/wizard.module.css';
import styles from './reservations.module.css';

type ReservationDetail = Reservation & { viewer: ReservationViewer };
type EditStep = 1 | 2;

const STEP_NAMES: Record<EditStep, string> = {
  1: 'Choose a new time',
  2: 'Confirm changes',
};

/**
 * Shown when a paid grow settled but the reservation did NOT move: the
 * backend dropped the parked change (lapsed at its TTL, superseded, or the
 * slot was gone at settle time) and auto-refunds the captured delta.
 */
const CHANGE_DROPPED_MESSAGE =
  'We could not apply your change in time. Your original booking is unchanged; if you were charged, the amount is refunded automatically.';

/**
 * The 2-step edit/reschedule wizard (Figma "Editing reservation"
 * 152:12072: edit-booking 325:15083/325:15177, confirm-changes 205:19481,
 * updated modal 205:19718). Organizer-only, on confirmed reservations.
 *
 * Step 1 reuses W3's date strip + slot list with the reservation's OWN
 * slots pre-selected and treated as available to itself; Continue stays
 * disabled until the selection actually changes.
 *
 * Step 2 confirms the money delta from POST :id/reschedule-quote:
 * - shrink/equal: PATCH applies the move immediately and any difference is
 *   refunded to the card on file;
 * - grow: the SAME hold-session + payment-lock + Payment Element pattern
 *   as W3 checkout collects the delta first. PATCH parks the change with a
 *   fresh PaymentIntent, the member pays, and POST :id/confirm applies the
 *   move. Nothing moves (and nothing is kept) on an unpaid change.
 *
 * On success confirmed guests are reset to pending and must re-accept;
 * the updated-booking modal says so.
 */
export function EditReservationPage() {
  const { reservationId = '' } = useParams();
  const navigate = useNavigate();

  const detail = useQuery(reservationQuery(reservationId));
  const types = useQuery(resourceTypesQuery);
  const membership = useQuery(membershipQuery);

  const backToDetail = useCallback(
    () => navigate(`/reservations/${reservationId}`),
    [navigate, reservationId],
  );

  if (detail.isPending || types.isPending || membership.isPending) {
    return <FullScreenLoader label="Loading reservation" />;
  }

  if (detail.isError || types.isError || membership.isError) {
    const error = detail.error ?? types.error ?? membership.error;
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      return (
        <EditGuardFrame onExit={backToDetail}>
          <EmptyState
            icon={<SearchX aria-hidden />}
            title="Reservation not found"
            description="This reservation does not exist, was removed, or you are not part of it."
            action={<ButtonLink to="/">Back to home</ButtonLink>}
          />
        </EditGuardFrame>
      );
    }
    return (
      <EditGuardFrame onExit={backToDetail}>
        <div className={wizard.errorBox} role="alert">
          <p>We could not load this reservation.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (detail.isError) void detail.refetch();
              if (types.isError) void types.refetch();
              if (membership.isError) void membership.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      </EditGuardFrame>
    );
  }

  const reservation = detail.data as ReservationDetail;
  const type = types.data.find((entry) => entry.code === reservation.typeCode);

  if (!reservation.viewer?.canManage) {
    return (
      <EditGuardFrame onExit={backToDetail}>
        <EmptyState
          icon={<SearchX aria-hidden />}
          title="Only the organizer can edit"
          description="Ask the member who booked this reservation to change it."
          action={<Button onClick={backToDetail}>Back to reservation</Button>}
        />
      </EditGuardFrame>
    );
  }

  if (!isEntitledMembershipStatus(membership.data.membership?.status ?? null)) {
    return (
      <EditGuardFrame onExit={backToDetail}>
        <MembershipInactiveState />
      </EditGuardFrame>
    );
  }

  if (reservation.status !== 'confirmed' || hasReservationStarted(reservation) || !type) {
    return (
      <EditGuardFrame onExit={backToDetail}>
        <EmptyState
          icon={<SearchX aria-hidden />}
          title="This reservation can no longer be edited"
          description={
            reservation.status !== 'confirmed'
              ? 'Only confirmed upcoming bookings can be rescheduled.'
              : 'This booking has already started.'
          }
          action={<Button onClick={backToDetail}>Back to reservation</Button>}
        />
      </EditGuardFrame>
    );
  }

  return <EditWizard key={reservation.id} detail={reservation} type={type} />;
}

/** Chrome-only frame for the guard states (no progress bar). */
function EditGuardFrame({ onExit, children }: { onExit: () => void; children: ReactNode }) {
  return (
    <div className={wizard.page}>
      <div className={wizard.column}>
        <header className={wizard.chrome}>
          <button type="button" className={wizard.chromeButton} onClick={onExit} aria-label="Back">
            <ArrowLeft aria-hidden />
          </button>
          <button
            type="button"
            className={wizard.chromeButton}
            onClick={onExit}
            aria-label="Close editing"
          >
            <X aria-hidden />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function EditWizard({ detail, type }: { detail: ReservationDetail; type: ResourceTypeSummary }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const currentSlots = reservationSlots(detail, type.slotDurationMinutes);

  const [step, setStep] = useState<EditStep>(1);
  const [date, setDate] = useState(detail.date);
  const [slots, setSlots] = useState<string[]>(currentSlots);
  const [notice, setNotice] = useState<string | null>(null);
  const [updated, setUpdated] = useState<{ reservation: Reservation; money: RescheduleMoney | null } | null>(null);
  const [paymentLocked, setPaymentLocked] = useState(false);

  /**
   * The W3 hold session, adapted to the reschedule contract: attempt
   * tokens still fence out-of-order PATCH responses and the payment lock
   * still freezes the chrome once a delta payment may have captured. The
   * cancel is a NO-OP by design: there is no client-cancel endpoint for a
   * parked change (DELETE cancels the whole reservation), and none is
   * needed; an unpaid change lapses at its TTL and any newer PATCH
   * supersedes it server-side.
   */
  const [holdSession] = useState<HoldSession>(() =>
    createHoldSession({ cancel: () => undefined, onLockChange: setPaymentLocked }),
  );
  useEffect(() => () => holdSession.release(), [holdSession]);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [step, updated]);

  const dirty = isSelectionChanged(detail, date, slots, type.slotDurationMinutes);

  const closeWizard = useCallback(() => {
    if (holdSession.paymentLocked) return;
    holdSession.release();
    navigate(`/reservations/${detail.id}`);
  }, [holdSession, navigate, detail.id]);

  const backToTimeStep = useCallback(
    (message: string | null) => {
      holdSession.release();
      void queryClient.invalidateQueries({ queryKey: ['availability', detail.typeCode] });
      setNotice(message);
      setStep(1);
    },
    [holdSession, queryClient, detail.typeCode],
  );

  const handleApplied = useCallback(
    (reservation: Reservation, money: RescheduleMoney | null) => {
      holdSession.settle();
      queryClient.setQueryData(['reservations', reservation.id], {
        ...reservation,
        viewer: detail.viewer,
      });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      void queryClient.invalidateQueries({ queryKey: ['availability', detail.typeCode] });
      setUpdated({ reservation, money });
    },
    [holdSession, queryClient, detail.typeCode, detail.viewer],
  );

  // ── Redirect-based payment return (?resume=1&redirect_status=...) ──

  const resuming = searchParams.get('resume') === '1';
  const redirectStatus = searchParams.get('redirect_status');
  // The requested move rides the return URL (to_*): after a redirect the
  // wizard's date/slots state is gone, and the return leg must be able to
  // tell "the move applied" from "the parked change was dropped and
  // refunded" (both end with no pendingChange).
  const resumeDate = searchParams.get('to_date');
  const resumeStart = searchParams.get('to_start');
  const resumeEnd = searchParams.get('to_end');
  const resumeTarget: MoveTarget | null =
    resumeDate && resumeStart && resumeEnd
      ? { date: resumeDate, startTime: resumeStart, endTime: resumeEnd }
      : null;
  const clearResumeParams = useCallback(() => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete('resume');
        next.delete('redirect_status');
        next.delete('payment_intent');
        next.delete('payment_intent_client_secret');
        next.delete('source_type');
        next.delete('to_date');
        next.delete('to_start');
        next.delete('to_end');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  if (resuming && !updated) {
    return (
      <EditRedirectReturn
        detail={detail}
        target={resumeTarget}
        redirectStatus={redirectStatus}
        onApplied={(reservation) => {
          clearResumeParams();
          handleApplied(reservation, null);
        }}
        onPaymentFailed={() => {
          clearResumeParams();
          holdSession.settle();
          backToTimeStep(
            'Your payment was not completed, so your reservation is unchanged. Pick a new time to try again.',
          );
        }}
        onChangeLost={(message) => {
          clearResumeParams();
          holdSession.settle();
          backToTimeStep(message);
        }}
      />
    );
  }

  // ── Success: the updated-booking modal ──

  if (updated) {
    return (
      <div className={wizard.page}>
        <UpdatedBookingSheet
          reservation={updated.reservation}
          money={updated.money}
          onInviteMore={() => navigate(`/reservations/${detail.id}/invite`)}
          onClose={() => navigate(`/reservations/${detail.id}`)}
        />
      </div>
    );
  }

  const goBack = () => {
    if (step === 1) {
      closeWizard();
      return;
    }
    if (holdSession.paymentLocked) return;
    holdSession.release();
    setStep(1);
  };

  return (
    <div className={wizard.page}>
      <div className={wizard.column}>
        <header className={wizard.chrome}>
          <button
            type="button"
            className={wizard.chromeButton}
            onClick={goBack}
            aria-label="Back"
            disabled={paymentLocked}
          >
            <ArrowLeft aria-hidden />
          </button>
          <button
            type="button"
            className={wizard.chromeButton}
            onClick={closeWizard}
            aria-label="Close editing"
            disabled={paymentLocked}
          >
            <X aria-hidden />
          </button>
        </header>

        <div
          className={wizard.progress}
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={2}
          aria-valuenow={step}
          aria-valuetext={`Step ${step} of 2: ${STEP_NAMES[step]}`}
        >
          {([1, 2] as const).map((index) => (
            <span
              key={index}
              className={[
                wizard.progressSegment,
                index === step ? wizard.progressActive : '',
                index < step ? wizard.progressDone : '',
              ].join(' ')}
            />
          ))}
        </div>

        {step === 1 && (
          <SelectTimeStep
            headingRef={headingRef}
            type={type}
            title="Edit booking"
            date={date}
            onDateChange={(next) => {
              setDate(next);
              setSlots(next === detail.date ? currentSlots : []);
            }}
            slots={slots}
            onSlotsChange={setSlots}
            extraAvailable={date === detail.date ? currentSlots : []}
            notice={notice}
            onDismissNotice={() => setNotice(null)}
            continueDisabled={!dirty}
            onContinue={() => setStep(2)}
          />
        )}

        {step === 2 && (
          <ConfirmChangesStep
            headingRef={headingRef}
            detail={detail}
            type={type}
            date={date}
            slots={slots}
            holdSession={holdSession}
            onApplied={handleApplied}
            onBackToTime={backToTimeStep}
          />
        )}
      </div>
    </div>
  );
}

// ── Step 2: confirm changes ──

interface ConfirmChangesStepProps {
  headingRef: React.Ref<HTMLHeadingElement>;
  detail: ReservationDetail;
  type: ResourceTypeSummary;
  date: string;
  slots: string[];
  holdSession: HoldSession;
  onApplied: (reservation: Reservation, money: RescheduleMoney | null) => void;
  onBackToTime: (message: string | null) => void;
}

function ConfirmChangesStep({
  headingRef,
  detail,
  type,
  date,
  slots,
  holdSession,
  onApplied,
  onBackToTime,
}: ConfirmChangesStepProps) {
  const stripeReady = getStripe() !== null;
  const noun = resourceNoun(detail.typeName);

  // Step 2 is only reachable with a non-empty, changed selection.
  const target = selectionTarget(date, slots, type.slotDurationMinutes)!;

  const quote = useQuery({
    queryKey: ['reschedule-quote', detail.id, date, slots],
    queryFn: () => api.rescheduleQuote(detail.id, { date, slots }),
  });
  const money = quote.data ? describeRescheduleMoney(quote.data) : null;

  // The immediate path (shrink/equal): PATCH applies the move on Save.
  const save = useMutation({
    mutationFn: () => api.rescheduleReservation(detail.id, { date, slots }),
    onSuccess: (result) => {
      onApplied(result.reservation, money);
    },
  });

  // The grow path: PATCH up front to park the change and mint the delta
  // PaymentIntent (mirroring checkout, which holds on entry). The hold
  // session's attempt token keeps the wizard's ledger honest if the
  // member backs out while the PATCH is in flight (the step unmounts, so
  // a stale response is never rendered; a superseded parked change lapses
  // or is dropped by the next PATCH server-side).
  const park = useMutation({
    mutationFn: async () => {
      const attempt = holdSession.beginAttempt();
      const result = await api.rescheduleReservation(detail.id, { date, slots });
      holdSession.holdCreated(detail.id, attempt);
      return result;
    },
  });
  const parked = park.data ?? null;

  const startedRef = useRef(false);
  const parkMutate = park.mutate;
  const growCents = money?.kind === 'charge' ? money.dueTodayCents : null;
  useEffect(() => {
    if (!stripeReady || growCents === null || startedRef.current) return;
    startedRef.current = true;
    parkMutate();
  }, [stripeReady, growCents, parkMutate]);

  // A parked "grow" the backend resolved as shrink/equal applied at once.
  const parkedApplied = parked !== null && parked.clientSecret === null;
  const appliedFiredRef = useRef(false);
  useEffect(() => {
    if (!parkedApplied || !parked || appliedFiredRef.current) return;
    appliedFiredRef.current = true;
    holdSession.settle();
    onApplied(parked.reservation, null);
  }, [parkedApplied, parked, holdSession, onApplied]);

  const confirm = useMutation({ mutationFn: () => api.confirmReservation(detail.id) });
  const [paying, setPaying] = useState(false);
  const [processingHold, setProcessingHold] = useState(false);

  const changeExpiresAt = parked?.reservation.pendingChange?.expiresAt ?? null;
  const changeSecondsLeft = useCountdown(changeExpiresAt);
  const changeLapsed =
    changeSecondsLeft !== null &&
    changeSecondsLeft <= 0 &&
    !paying &&
    !confirm.isPending &&
    !confirm.isError &&
    !processingHold;

  async function handlePaid() {
    try {
      const reservation = await confirm.mutateAsync();
      // "The pending change is gone" is NOT proof the move applied (a
      // dropped change also clears it); only the reservation actually
      // sitting on the requested date AND time counts as success.
      if (!reservation.pendingChange && reservationMatchesMove(reservation, target)) {
        onApplied(reservation, money);
        return;
      }
      // The change was swept before the payment settled it; any captured
      // delta is refunded by the backend's orphan path.
      onBackToTime(CHANGE_DROPPED_MESSAGE);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PAYMENT_REQUIRED') {
        setProcessingHold(true);
        return;
      }
      if (error instanceof ApiError && error.code === 'SLOT_UNAVAILABLE') {
        onBackToTime(
          'That time was taken while you paid. Your original booking is unchanged and the charge is refunded automatically.',
        );
        return;
      }
      if (error instanceof ApiError && error.code === 'INVALID_STATUS') {
        onBackToTime('This reservation changed while you were editing it.');
      }
      // Anything else: the confirm retry panel below handles it.
    }
  }

  const frame = (children: ReactNode) => (
    <div className={[wizard.step, wizard.stepCheckout].join(' ')}>
      <h1 ref={headingRef} tabIndex={-1} className={wizard.stepTitle}>
        Confirm changes
      </h1>
      <p className={wizard.stepSubtitle}>Confirm to update your reservation</p>
      {children}
    </div>
  );

  // ── Failure states from quote / PATCH ──

  const failure = describeEditFailure(quote.error ?? save.error ?? park.error);
  if (failure) {
    if (failure.kind === 'membership') {
      return frame(<MembershipInactiveState />);
    }
    if (failure.kind === 'back-to-time') {
      return frame(
        <div className={wizard.noticeBox} role="alert">
          <p>{failure.message}</p>
          <Button onClick={() => onBackToTime(null)}>Pick another time</Button>
        </div>,
      );
    }
    return frame(
      <div className={wizard.errorBox} role="alert">
        <p>{failure.message}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            save.reset();
            park.reset();
            startedRef.current = false;
            void quote.refetch();
          }}
        >
          Try again
        </Button>
      </div>,
    );
  }

  if (quote.isPending) {
    return frame(
      <div className={wizard.checkoutLoading} aria-busy="true" role="status">
        <span className="visually-hidden">Pricing your change</span>
        <Skeleton height="9rem" shape="card" />
        <Skeleton height="10rem" shape="card" />
      </div>,
    );
  }

  const quoted = quote.data;

  const summary = (
    <div className={wizard.checkoutSummary}>
      <ChangeSummaryCard
        detail={detail}
        newDate={target.date}
        newStart={target.startTime}
        newEnd={target.endTime}
      />
      <EditOrderSummary noun={noun} detail={detail} quoted={quoted} money={money!} />
    </div>
  );

  // ── Shrink / equal: Save applies immediately ──

  if (money!.kind !== 'charge') {
    return frame(
      <div className={wizard.checkoutGrid}>
        {summary}
        <div className={wizard.checkoutPayment}>
          {money!.kind === 'refund' && (
            <p className={styles.dialogHint}>
              The difference is refunded to the card you paid with; no payment is needed today.
            </p>
          )}
          <div className={wizard.stepFooter}>
            <Button fullWidth loading={save.isPending} onClick={() => save.mutate()}>
              Save changes
            </Button>
          </div>
        </div>
      </div>,
    );
  }

  // ── Grow: collect the delta with the shared Payment Element pattern ──

  if (!stripeReady) {
    return frame(
      <EmptyState
        title="Payments are not configured"
        description="Set VITE_STRIPE_PUBLISHABLE_KEY to enable payments in this environment."
      />,
    );
  }

  if (changeLapsed) {
    return frame(
      <div className={wizard.noticeBox} role="alert">
        <p>Your change request expired before the payment completed. Nothing was changed.</p>
        <Button onClick={() => onBackToTime(null)}>Choose a new time</Button>
      </div>,
    );
  }

  if (processingHold) {
    return frame(
      <div className={wizard.processing} role="status">
        <p className={wizard.processingTitle}>Your payment is processing</p>
        <p className={wizard.processingBody}>
          Your new time will be confirmed as soon as the payment clears.
        </p>
        <Button
          variant="secondary"
          size="sm"
          loading={confirm.isPending}
          onClick={() => void handlePaid()}
        >
          Check again
        </Button>
      </div>,
    );
  }

  if (park.isPending || !parked || parkedApplied) {
    return frame(
      <div className={wizard.checkoutLoading} aria-busy="true" role="status">
        <span className="visually-hidden">Preparing your payment</span>
        <Skeleton height="9rem" shape="card" />
        <Skeleton height="12rem" shape="card" />
      </div>,
    );
  }

  return frame(
    <div className={wizard.checkoutGrid}>
      {summary}
      <div className={wizard.checkoutPayment}>
        <StripeProvider key={parked.clientSecret} clientSecret={parked.clientSecret!}>
          <BookingPaymentForm
            returnUrl={editReturnUrl(detail.id, target)}
            confirmError={confirm.isError}
            confirmPending={confirm.isPending}
            onRetryConfirm={() => void handlePaid()}
            paying={paying}
            setPaying={setPaying}
            onPaymentLock={(locked) => holdSession.setPaymentLocked(locked)}
            onPaid={handlePaid}
            totalCents={parked.deltaCents}
            submitLabel="Save changes"
          />
        </StripeProvider>
      </div>

      {(paying || confirm.isPending) && (
        <ProcessingScreen
          noun={noun}
          title="Updating your booking..."
          body="We're moving your reservation to its new time"
        />
      )}
    </div>,
  );
}

/** The booking card with old -> new date/time rows (Figma 205:19481). */
function ChangeSummaryCard({
  detail,
  newDate,
  newStart,
  newEnd,
}: {
  detail: Reservation;
  newDate: string;
  newStart: string;
  newEnd: string;
}) {
  const dateChanged = newDate !== detail.date;
  const oldRange = formatTimeRangeCompact(detail.startTime, detail.endTime);
  const newRange = formatTimeRangeCompact(newStart, newEnd);
  // Time changes on its own merits: a date-only move must not strike
  // through (and re-print) an identical time range.
  const timeChanged = oldRange !== newRange;

  return (
    <ReservationCard
      typeCode={detail.typeCode}
      typeName={detail.typeName}
      resourceName={detail.resource.name}
      rows={[]}
    >
      <div className={styles.changeCardRows}>
        <p className={styles.changeRow}>
          <CalendarDays aria-hidden className={styles.changeRowIcon} />
          {dateChanged ? (
            <>
              <s className={styles.changeOld}>{formatDateLong(detail.date)}</s>
              <ArrowRight aria-hidden className={styles.changeArrow} />
              <span>{formatDateLong(newDate)}</span>
              {/* <s> carries no old/new semantics for screen readers. */}
              <span className="visually-hidden">
                Changed from {formatDateLong(detail.date)} to {formatDateLong(newDate)}
              </span>
            </>
          ) : (
            <span>{formatDateLong(newDate)}</span>
          )}
        </p>
        <p className={styles.changeRow}>
          <Clock aria-hidden className={styles.changeRowIcon} />
          {timeChanged ? (
            <>
              <s className={styles.changeOld}>{oldRange}</s>
              <ArrowRight aria-hidden className={styles.changeArrow} />
              <span>{newRange}</span>
              <span className="visually-hidden">Changed from {oldRange} to {newRange}</span>
            </>
          ) : (
            <span>{newRange}</span>
          )}
        </p>
      </div>
    </ReservationCard>
  );
}

/** ORDER SUMMARY with the reschedule delta (Figma 205:19481). */
function EditOrderSummary({
  noun,
  detail,
  quoted,
  money,
}: {
  noun: string;
  detail: Reservation;
  quoted: { durationMinutes: number } | undefined;
  money: RescheduleMoney;
}) {
  const durationMinutes = quoted?.durationMinutes ?? 0;
  const hours = durationMinutes / 60;
  const hoursLabel = hours === 1 ? '1 hour' : `${hours} hours`;

  return (
    <Card className={wizard.orderSummary}>
      <h2 className={wizard.orderSummaryTitle}>Order summary</h2>
      <div className={wizard.orderSummaryRow}>
        <span className={wizard.orderSummaryLabel}>
          {noun.charAt(0).toUpperCase() + noun.slice(1)} fee
        </span>
        <span className={wizard.orderSummaryRate}>
          {formatAmountWithCents(detail.hourlyRateCents)} <span>/ hour</span>
          <br />
          <span>x {hoursLabel}</span>
        </span>
      </div>
      {money.netPaidCents > 0 && (
        <div className={wizard.orderSummaryRow}>
          <span className={wizard.orderSummaryLabel}>Previous payment</span>
          <span className={wizard.orderSummaryRate}>
            - {formatAmountWithCents(money.netPaidCents)}
          </span>
        </div>
      )}
      <hr className={wizard.orderSummaryDivider} />
      <div className={wizard.orderSummaryRow}>
        <span className={wizard.orderSummaryTotalLabel}>Total due today</span>
        <span className={wizard.orderSummaryTotal}>
          {formatAmountWithCents(money.dueTodayCents)}
        </span>
      </div>
      {money.kind === 'refund' && (
        <p className={styles.summaryNote}>
          * You will be refunded {formatAmountWithCents(money.refundCents)} to the account on
          file
        </p>
      )}
    </Card>
  );
}

// ── Success modal (Figma confirm-changes-modal 205:19718) ──

function UpdatedBookingSheet({
  reservation,
  money,
  onInviteMore,
  onClose,
}: {
  reservation: Reservation;
  money: RescheduleMoney | null;
  onInviteMore: () => void;
  onClose: () => void;
}) {
  const noun = resourceNoun(reservation.typeName);
  const roster = reservation.participants.filter(
    (participant) => participant.status === 'confirmed' || participant.status === 'pending',
  );
  const pendingCount = roster.filter((participant) => participant.status === 'pending').length;

  return (
    <Sheet open onClose={onClose} title="Booking updated">
      <div className={wizard.confirmation}>
        <h3 className={wizard.confirmationTitle}>Your {noun} booking was updated</h3>
        <p className={wizard.confirmationCaption}>A confirmation has been sent to your email</p>

        <ReservationCard
          typeCode={reservation.typeCode}
          typeName={reservation.typeName}
          resourceName={reservation.resource.name}
          layout="rows"
          rows={[
            { label: 'Date', value: formatDateFull(reservation.date) },
            {
              label: 'Time',
              value: formatTimeRangeCompact(reservation.startTime, reservation.endTime),
            },
            { label: 'Booking ref', value: bookingRefLabel(reservation.reference) },
            { label: 'Amount paid', value: formatAmountWithCents(reservation.amountPaidCents) },
          ]}
        />

        {money?.kind === 'refund' && (
          <p className={wizard.confirmationCaption}>
            {formatAmountWithCents(money.refundCents)} is being refunded to your card
          </p>
        )}

        <div className={wizard.sectionHead}>
          <span className={wizard.sectionLabel}>
            Players <span className={wizard.sectionCount}>{roster.length}</span>{' '}
            {pendingCount > 0 && (
              <span className={styles.resetWarning} role="status">
                will need to reaccept their invitations
              </span>
            )}
          </span>
        </div>

        <ul className={wizard.confirmationRoster}>
          {roster.map((participant) => {
            const name = memberDisplayName(participant);
            return (
              <li key={participant.memberId} className={wizard.confirmationPlayer}>
                <Avatar name={name} size="md" />
                <span className={wizard.confirmationPlayerName}>{name}</span>
                <span
                  className={[
                    wizard.confirmationStatus,
                    participant.status === 'confirmed' ? wizard.confirmationStatusConfirmed : '',
                  ].join(' ')}
                >
                  {participant.status === 'confirmed' ? 'Confirmed' : 'Pending'}
                </span>
              </li>
            );
          })}
        </ul>

        <div className={wizard.confirmationActions}>
          <Button fullWidth onClick={onInviteMore}>
            Invite more players
          </Button>
          <button type="button" className={wizard.confirmationLink} onClick={onClose}>
            Go to reservation
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ── Redirect-based payment return ──

function EditRedirectReturn({
  detail,
  target,
  redirectStatus,
  onApplied,
  onPaymentFailed,
  onChangeLost,
}: {
  detail: ReservationDetail;
  /** The requested move, restored from the return URL's to_* params. */
  target: MoveTarget | null;
  redirectStatus: string | null;
  onApplied: (reservation: Reservation) => void;
  onPaymentFailed: () => void;
  onChangeLost: (message: string) => void;
}) {
  const [processingHold, setProcessingHold] = useState(false);

  // The requested move survives the redirect in the return URL; if those
  // params were stripped, the change still parked on the reservation at
  // return time names the same destination. With neither there is nothing
  // to verify against, and a clean confirm is trusted as applied.
  const requested =
    target ??
    (detail.pendingChange
      ? {
          date: detail.pendingChange.date,
          startTime: detail.pendingChange.startTime,
          endTime: detail.pendingChange.endTime,
        }
      : null);

  const confirm = useMutation({
    mutationFn: () => api.confirmReservation(detail.id),
    onSuccess: (reservation) => {
      if (reservation.pendingChange) {
        // Still parked and unpaid after the redirect: treat as not completed.
        onPaymentFailed();
        return;
      }
      if (requested === null || reservationMatchesMove(reservation, requested)) {
        onApplied(reservation);
        return;
      }
      // No pending change AND not on the requested time: the parked change
      // was dropped (lapsed at its TTL, superseded, or slot gone) and the
      // captured delta is auto-refunded; the member keeps the original.
      onChangeLost(CHANGE_DROPPED_MESSAGE);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'PAYMENT_REQUIRED') {
        setProcessingHold(true);
        return;
      }
      if (error instanceof ApiError && error.code === 'SLOT_UNAVAILABLE') {
        onChangeLost(
          'That time was taken while you paid. Your original booking is unchanged and the charge is refunded automatically.',
        );
        return;
      }
      if (
        error instanceof ApiError &&
        (error.code === 'INVALID_STATUS' || error.code === 'NOT_FOUND')
      ) {
        onChangeLost('This reservation changed while you were editing it.');
      }
    },
  });

  const failed = redirectStatus === 'failed' || redirectStatus === 'requires_payment_method';

  const startedRef = useRef(false);
  const confirmMutate = confirm.mutate;
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (failed) {
      // The parked change stays unpaid and lapses at its TTL server-side;
      // nothing to clean up client-side.
      onPaymentFailed();
      return;
    }
    confirmMutate();
  }, [failed, confirmMutate, onPaymentFailed]);

  if (processingHold) {
    return (
      <div className={wizard.page}>
        <div className={wizard.column}>
          <div className={wizard.processing} role="status">
            <p className={wizard.processingTitle}>Your payment is processing</p>
            <p className={wizard.processingBody}>
              Your new time will be confirmed as soon as the payment clears.
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
        </div>
      </div>
    );
  }

  if (confirm.isError && !failed) {
    const error = confirm.error;
    const terminal =
      error instanceof ApiError &&
      (error.code === 'SLOT_UNAVAILABLE' ||
        error.code === 'INVALID_STATUS' ||
        error.code === 'NOT_FOUND');
    if (!terminal) {
      return (
        <div className={wizard.page}>
          <div className={wizard.column}>
            <div className={wizard.errorBox} role="alert">
              <p>
                Your payment went through, but we could not confirm the change. Retry, or refresh
                this page; you will not be charged twice.
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
          </div>
        </div>
      );
    }
  }

  return (
    <ProcessingScreen
      noun={resourceNoun(detail.typeName)}
      title="Updating your booking..."
      body="We're moving your reservation to its new time"
    />
  );
}

// ── Helpers ──

/**
 * The Stripe return URL for a redirect-based delta payment. It carries the
 * requested move (to_*) so the return leg can verify the reservation
 * actually landed on it; see EditRedirectReturn.
 */
function editReturnUrl(reservationId: string, target: MoveTarget): string {
  const params = new URLSearchParams({
    resume: '1',
    to_date: target.date,
    to_start: target.startTime,
    to_end: target.endTime,
  });
  return `${window.location.origin}/reservations/${encodeURIComponent(reservationId)}/edit?${params.toString()}`;
}

interface EditFailure {
  kind: 'membership' | 'back-to-time' | 'retry';
  message: string;
}

/** Maps quote/PATCH ApiErrors onto the edit flow's failure states. */
function describeEditFailure(error: unknown): EditFailure | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'SLOT_UNAVAILABLE':
        return {
          kind: 'back-to-time',
          message: 'That time was just taken by another member. Pick another slot.',
        };
      case 'INACTIVE_MEMBERSHIP':
      case 'TIER_REQUIRED':
        return { kind: 'membership', message: error.message };
      case 'MAX_BOOKINGS':
        return {
          kind: 'back-to-time',
          message: 'You have reached the booking limit for that day.',
        };
      case 'BOOKING_IN_PAST':
      case 'TOO_FAR_ADVANCE':
      case 'OUTSIDE_HOURS':
      case 'INVALID_SLOTS':
        return {
          kind: 'back-to-time',
          message: 'That time can no longer be booked. Pick another slot.',
        };
      case 'PAYMENT_TOO_SMALL':
        return {
          kind: 'back-to-time',
          message:
            'The price difference for this change is too small to charge. Pick a different time.',
        };
      case 'RESERVATION_CHANGED':
        return {
          kind: 'retry',
          message: 'The price of this change was updated. Review it and try again.',
        };
      case 'INVALID_STATUS':
        return {
          kind: 'back-to-time',
          message: 'This reservation changed while you were editing it.',
        };
      default:
        return { kind: 'retry', message: 'We could not prepare your change.' };
    }
  }
  return { kind: 'retry', message: 'We could not prepare your change.' };
}
