import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Clock } from 'lucide-react';
import { api, ApiError, type Reservation, type ResourceTypeSummary } from '../../lib/api';
import {
  formatDateLong,
  formatDuration,
  formatTimeRangeCompact,
  resourceNoun,
  selectionSummary,
} from '../../lib/booking';
import { formatAmountWithCents } from '../../lib/plan-pricing';
import { inviteesPayload, type InviteSelection } from '../../lib/invites';
import { getStripe } from '../../lib/stripe';
import { StripeProvider } from '../../lib/StripeProvider';
import {
  Button,
  Card,
  EmptyState,
  ReservationCard,
  Skeleton,
  Spinner,
} from '../../components';
import { MembershipInactiveState } from './MembershipInactiveState';
import styles from './wizard.module.css';

/**
 * Wizard step 3 (Figma court-review-summary 14:582): checkout.
 *
 * The flow against the backend's hold/pay/confirm contract:
 *  1. POST /api/reservations/quote prices the selection server-side (and
 *     verifies a single court can still host it).
 *  2. POST /api/reservations HOLDS the slot: the reservation is created as
 *     pending_payment with a ~12 minute hold TTL, the specific court is
 *     assigned server-side (revealed here), and a Stripe PaymentIntent's
 *     client secret is returned.
 *  3. The Payment Element mounts on that secret; Confirm & pay runs
 *     stripe.confirmPayment (decline/SCA inline; redirect methods return
 *     to the wizard URL with ?reservation=...).
 *  4. POST /api/reservations/:id/confirm asserts the payment captured and
 *     flips the hold to confirmed ("securing your spot"). Retrying uses
 *     the same PaymentIntent, so nothing double-charges.
 *
 * The states the Figma omits are defined here per CONVENTIONS: the slot
 * being taken between selection and hold (409 SLOT_UNAVAILABLE), the hold
 * expiring before payment (countdown + 409 HOLD_EXPIRED), and declines
 * (inline Payment Element error; the hold stays until it expires).
 */

const HOLD_WARNING_SECONDS = 120;

export interface CheckoutStepProps {
  headingRef: Ref<HTMLHeadingElement>;
  type: ResourceTypeSummary;
  date: string;
  slots: string[];
  invites: InviteSelection;
  onHoldCreated: (reservationId: string) => void;
  onConfirmed: (reservation: Reservation) => void;
  /** Slot taken / hold expired: release and return to the time step. */
  onPickAnotherTime: (message: string | null) => void;
}

export function CheckoutStep({
  headingRef,
  type,
  date,
  slots,
  invites,
  onHoldCreated,
  onConfirmed,
  onPickAnotherTime,
}: CheckoutStepProps) {
  const stripeReady = getStripe() !== null;

  const quote = useQuery({
    queryKey: ['booking-quote', type.code, date, slots],
    queryFn: () => api.quoteReservation({ typeCode: type.code, date, slots }),
    enabled: stripeReady,
  });

  const create = useMutation({
    // The hold is reported from inside mutationFn, not onSuccess: the
    // request outlives this step if the member backs out mid-flight, and
    // the wizard must learn about the hold to release it either way.
    mutationFn: async (input: Parameters<typeof api.createReservation>[0]) => {
      const result = await api.createReservation(input);
      onHoldCreated(result.reservation.id);
      return result;
    },
  });

  const confirm = useMutation({ mutationFn: api.confirmReservation });

  // "The charge reached Stripe but has not cleared yet" (async payment
  // methods): manual re-check instead of a retry that could double-charge.
  const [processingHold, setProcessingHold] = useState(false);
  const [holdExpired, setHoldExpired] = useState(false);
  const [paying, setPaying] = useState(false);

  // Hold the slot as soon as the server quote lands (the Figma checkout is
  // entered with the court already assigned). StrictMode-safe via ref.
  const startedRef = useRef(false);
  const createMutate = create.mutate;
  useEffect(() => {
    if (!stripeReady || !quote.isSuccess || startedRef.current) return;
    startedRef.current = true;
    createMutate({
      typeCode: type.code,
      date,
      slots,
      invitees: inviteesPayload(invites),
    });
  }, [stripeReady, quote.isSuccess, createMutate, type.code, date, slots, invites]);

  const held = create.data ?? null;
  const holdSecondsLeft = useCountdown(held?.holdExpiresAt ?? null);

  // The hold lapsing while the member is still looking at the form.
  // Derived, not stored: while a payment/confirmation is in flight (or a
  // paid confirm needs a retry) the countdown stays hands-off, because the
  // backend recovers a paid-but-expired hold (re-acquire or auto-refund).
  const countdownLapsed = holdSecondsLeft !== null && holdSecondsLeft <= 0;
  const showHoldExpired =
    holdExpired ||
    (countdownLapsed && !paying && !confirm.isPending && !confirm.isError && !processingHold);

  async function handlePaid() {
    if (!held) return;
    try {
      const reservation = await confirm.mutateAsync(held.reservation.id);
      onConfirmed(reservation);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PAYMENT_REQUIRED') {
        // confirmPayment succeeded inline, so the charge is at Stripe: a
        // 402 read-back means it is still clearing, not a failure.
        setProcessingHold(true);
        return;
      }
      if (error instanceof ApiError && (error.code === 'HOLD_EXPIRED' || error.code === 'INVALID_STATUS')) {
        setHoldExpired(true);
        return;
      }
      // Anything else: the retry panel below (confirm.isError) handles it.
    }
  }

  const noun = resourceNoun(type.name);
  const summary = selectionSummary(slots, type.slotDurationMinutes, type.hourlyRateCents);

  const frame = (children: ReactNode) => (
    <div className={[styles.step, styles.stepCheckout].join(' ')}>
      <h1 ref={headingRef} tabIndex={-1} className={styles.stepTitle}>
        Checkout
      </h1>
      <p className={styles.stepSubtitle}>Confirm &amp; pay to reserve your spot</p>
      {children}
    </div>
  );

  if (!stripeReady) {
    return frame(
      <EmptyState
        title="Payments are not configured"
        description="Set VITE_STRIPE_PUBLISHABLE_KEY to enable checkout in this environment."
      />,
    );
  }

  // ── Failure states from quote/create ──

  const failure = describeBookingFailure(quote.error ?? create.error);
  if (failure) {
    if (failure.kind === 'membership') {
      return frame(<MembershipInactiveState />);
    }
    if (failure.kind === 'back-to-time') {
      return frame(
        <div className={styles.noticeBox} role="alert">
          <p>{failure.message}</p>
          <Button onClick={() => onPickAnotherTime(null)}>Pick another time</Button>
        </div>,
      );
    }
    return frame(
      <div className={styles.errorBox} role="alert">
        <p>{failure.message}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            if (quote.isError) {
              void quote.refetch();
            } else {
              startedRef.current = true;
              create.mutate({ typeCode: type.code, date, slots, invitees: inviteesPayload(invites) });
            }
          }}
        >
          Try again
        </Button>
      </div>,
    );
  }

  // ── Hold expired ──

  if (showHoldExpired) {
    return frame(
      <div className={styles.noticeBox} role="alert">
        <p>
          Your {noun} hold expired before the payment completed. If you were charged, the
          amount is refunded automatically.
        </p>
        <Button onClick={() => onPickAnotherTime(null)}>Choose a new time</Button>
      </div>,
    );
  }

  // ── Payment reached Stripe, still clearing ──

  if (processingHold) {
    return frame(
      <div className={styles.processing} role="status">
        <p className={styles.processingTitle}>Your payment is processing</p>
        <p className={styles.processingBody}>
          Your booking will be confirmed as soon as the payment clears. This can take a
          moment for some payment methods.
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

  // ── Loading quote / creating the hold ──

  if (quote.isPending || create.isPending || (quote.isSuccess && !held)) {
    return frame(
      <div className={styles.checkoutLoading} aria-busy="true" role="status">
        <span className="visually-hidden">Preparing your booking</span>
        <Skeleton height="9rem" shape="card" />
        <Skeleton height="8rem" shape="card" />
        <Skeleton height="12rem" shape="card" />
      </div>,
    );
  }

  if (!held || held.clientSecret === null) {
    // A member checkout always gets a client secret; treat its absence as
    // an unexpected failure rather than rendering a payment form on nothing.
    return frame(
      <div className={styles.errorBox} role="alert">
        <p>We could not start your payment. The held time was released.</p>
        <Button variant="secondary" size="sm" onClick={() => onPickAnotherTime(null)}>
          Back to time selection
        </Button>
      </div>,
    );
  }

  const reservation = held.reservation;
  const quoted = quote.data;

  return frame(
    <div className={styles.checkoutGrid}>
      <div className={styles.checkoutSummary}>
        <ReservationCard
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
          noun={noun}
          hourlyRateCents={quoted?.hourlyRateCents ?? type.hourlyRateCents}
          durationMinutes={quoted?.durationMinutes ?? summary?.durationMinutes ?? 0}
          totalCents={held.totalCents}
        />
        {holdSecondsLeft !== null && (
          <p
            className={[
              styles.holdHint,
              holdSecondsLeft <= HOLD_WARNING_SECONDS ? styles.holdHintUrgent : '',
            ].join(' ')}
            role="status"
          >
            <Clock aria-hidden className={styles.holdHintIcon} />
            {reservation.resource.name} is held for you for{' '}
            <strong>{formatCountdown(holdSecondsLeft)}</strong>
          </p>
        )}
      </div>

      <div className={styles.checkoutPayment}>
        <StripeProvider key={held.clientSecret} clientSecret={held.clientSecret}>
          <BookingPaymentForm
            returnUrl={bookingReturnUrl(type.code, reservation.id)}
            confirmError={confirm.isError}
            confirmPending={confirm.isPending}
            onRetryConfirm={() => void handlePaid()}
            paying={paying}
            setPaying={setPaying}
            onPaid={handlePaid}
            totalCents={held.totalCents}
          />
        </StripeProvider>
      </div>

      {(paying || confirm.isPending) && (
        <ProcessingScreen resourceName={reservation.resource.name} noun={noun} />
      )}
    </div>,
  );
}

// ── Pieces ──

function OrderSummary({
  noun,
  hourlyRateCents,
  durationMinutes,
  totalCents,
}: {
  noun: string;
  hourlyRateCents: number;
  durationMinutes: number;
  totalCents: number;
}) {
  const hours = durationMinutes / 60;
  const hoursLabel = hours === 1 ? '1 hour' : `${hours} hours`;
  return (
    <Card className={styles.orderSummary}>
      <h2 className={styles.orderSummaryTitle}>Order summary</h2>
      <div className={styles.orderSummaryRow}>
        <span className={styles.orderSummaryLabel}>
          {noun.charAt(0).toUpperCase() + noun.slice(1)} fee
        </span>
        <span className={styles.orderSummaryRate}>
          {formatAmountWithCents(hourlyRateCents)} <span>/ hour</span>
          <br />
          <span>x {hoursLabel}</span>
        </span>
      </div>
      <hr className={styles.orderSummaryDivider} />
      <div className={styles.orderSummaryRow}>
        <span className={styles.orderSummaryTotalLabel}>Total due today</span>
        <span className={styles.orderSummaryTotal}>{formatAmountWithCents(totalCents)}</span>
      </div>
    </Card>
  );
}

function bookingReturnUrl(typeCode: string, reservationId: string): string {
  return `${window.location.origin}/reserve/${encodeURIComponent(typeCode)}?reservation=${encodeURIComponent(reservationId)}`;
}

function BookingPaymentForm({
  returnUrl,
  confirmError,
  confirmPending,
  onRetryConfirm,
  paying,
  setPaying,
  onPaid,
  totalCents,
}: {
  returnUrl: string;
  confirmError: boolean;
  confirmPending: boolean;
  onRetryConfirm: () => void;
  paying: boolean;
  setPaying: (paying: boolean) => void;
  onPaid: () => Promise<void>;
  totalCents: number;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements || paying) return;
    setPaying(true);
    setPayError(null);
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        // Cards and SCA challenges complete inline; only redirect-based
        // payment methods leave the page (and return to return_url).
        redirect: 'if_required',
      });
      if (error) {
        // Decline path: the hold stays live until its TTL, and retrying
        // reuses the same PaymentIntent, so a retry can never double-charge.
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

      {payError && (
        <p role="alert" className={styles.payAlert}>
          {payError}
        </p>
      )}

      {confirmError && (
        <div className={styles.errorBox} role="alert">
          <p>
            Your payment went through, but we could not confirm your booking. Retry, or
            refresh this page; you will not be charged twice.
          </p>
          <Button variant="secondary" size="sm" loading={confirmPending} onClick={onRetryConfirm}>
            Try again
          </Button>
        </div>
      )}

      <div className={styles.stepFooter}>
        <Button
          type="submit"
          fullWidth
          disabled={!ready || !stripe}
          loading={paying || confirmPending}
        >
          Confirm &amp; pay {formatAmountWithCents(totalCents)}
        </Button>
      </div>
    </form>
  );
}

/**
 * Full-screen processing takeover (Figma loading-state 7:2845): shown
 * while the payment confirms and the hold flips to a confirmed booking.
 */
function ProcessingScreen({ resourceName, noun }: { resourceName?: string; noun: string }) {
  return (
    <div className={styles.processingScreen} role="status">
      <Spinner size={40} />
      <p className={styles.processingScreenTitle}>Processing your booking...</p>
      <p className={styles.processingScreenBody}>
        {resourceName
          ? `We're securing your spot on ${resourceName}`
          : `We're securing your ${noun}`}
      </p>
      <p className={styles.processingScreenNote}>Please do not close this page or refresh</p>
    </div>
  );
}

// ── Redirect-based payment return ──

export interface RedirectReturnProps {
  type: ResourceTypeSummary;
  reservationId: string;
  redirectStatus: string | null;
  onConfirmed: (reservation: Reservation) => void;
  /** The charge did NOT go through; the hold was released. */
  onPaymentFailed: (reservation: Reservation | null) => void;
  onHoldExpired: () => void;
}

/**
 * Landing for redirect-based payment methods (return_url carries the
 * reservation id). A failed redirect releases the hold and restores the
 * time selection; anything else confirms exactly like the inline path.
 * There is no endpoint to re-open a payment on an existing hold, so a
 * failed redirect always goes back through a fresh hold.
 */
export function RedirectReturn({
  type,
  reservationId,
  redirectStatus,
  onConfirmed,
  onPaymentFailed,
  onHoldExpired,
}: RedirectReturnProps) {
  const [processingHold, setProcessingHold] = useState(false);

  const confirm = useMutation({
    mutationFn: () => api.confirmReservation(reservationId),
    onSuccess: onConfirmed,
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'PAYMENT_REQUIRED') {
        setProcessingHold(true);
        return;
      }
      if (
        error instanceof ApiError &&
        (error.code === 'HOLD_EXPIRED' || error.code === 'INVALID_STATUS' || error.code === 'NOT_FOUND')
      ) {
        onHoldExpired();
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
      // Restore the draft from the held reservation, then release it: the
      // client secret is gone after a redirect, so retrying means a fresh
      // hold with a fresh PaymentIntent (never a double charge).
      void (async () => {
        let reservation: Reservation | null = null;
        try {
          reservation = await api.getReservation(reservationId);
        } catch {
          reservation = null;
        }
        try {
          await api.cancelReservation(reservationId);
        } catch {
          // Already expired or cancelled: same outcome.
        }
        onPaymentFailed(reservation);
      })();
      return;
    }
    confirmMutate();
  }, [failed, confirmMutate, reservationId, onPaymentFailed]);

  if (processingHold) {
    return (
      <div className={styles.page}>
        <div className={styles.column}>
          <div className={styles.processing} role="status">
            <p className={styles.processingTitle}>Your payment is processing</p>
            <p className={styles.processingBody}>
              Your booking will be confirmed as soon as the payment clears.
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
      (error.code === 'HOLD_EXPIRED' || error.code === 'INVALID_STATUS' || error.code === 'NOT_FOUND');
    if (!terminal) {
      return (
        <div className={styles.page}>
          <div className={styles.column}>
            <div className={styles.errorBox} role="alert">
              <p>
                Your payment went through, but we could not confirm your booking. Retry, or
                refresh this page; you will not be charged twice.
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

  return <ProcessingScreen noun={resourceNoun(type.name)} />;
}

// ── Helpers ──

interface BookingFailure {
  kind: 'membership' | 'back-to-time' | 'retry';
  message: string;
}

/** Maps quote/create ApiErrors onto the checkout's failure states. */
function describeBookingFailure(error: unknown): BookingFailure | null {
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
          message: 'You have reached the booking limit for this day.',
        };
      case 'BOOKING_IN_PAST':
      case 'TOO_FAR_ADVANCE':
      case 'OUTSIDE_HOURS':
      case 'INVALID_SLOTS':
        return {
          kind: 'back-to-time',
          message: 'That time can no longer be booked. Pick another slot.',
        };
      case 'INVITEE_NOT_FOUND':
      case 'CLUB_NOT_FOUND':
        return {
          kind: 'retry',
          message: 'One of your invites could not be found. Go back and review your invites.',
        };
      default:
        return { kind: 'retry', message: 'We could not prepare your booking.' };
    }
  }
  return { kind: 'retry', message: 'We could not prepare your booking.' };
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** Seconds until the ISO instant, ticking every second; null without one. */
function useCountdown(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}
