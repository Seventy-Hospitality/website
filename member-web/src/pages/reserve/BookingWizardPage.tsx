import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, SearchX, X } from 'lucide-react';
import { api, type Reservation } from '../../lib/api';
import {
  formatDateHeading,
  formatTimeRangeCompact,
  selectionSummary,
  slotsFromRange,
  todayDateKey,
} from '../../lib/booking';
import {
  EMPTY_INVITE_SELECTION,
  inviteCount,
  inviteesPayload,
  type InviteSelection,
} from '../../lib/invites';
import { Button, EmptyState, FullScreenLoader, useToast } from '../../components';
import { membershipQuery } from '../onboarding/onboarding-data';
import { isEntitledMembershipStatus, resourceTypesQuery } from './booking-data';
import { MembershipInactiveState } from './MembershipInactiveState';
import { SelectTimeStep } from './SelectTimeStep';
import { InvitePlayersStep } from './InvitePlayersStep';
import { CheckoutStep, RedirectReturn } from './CheckoutStep';
import { ConfirmationSheet } from './ConfirmationSheet';
import styles from './wizard.module.css';

type WizardStep = 1 | 2 | 3;

const STEP_NAMES: Record<WizardStep, string> = {
  1: 'Choose a time',
  2: 'Invite players',
  3: 'Checkout',
};

/**
 * The 3-step booking wizard (Figma "Booking badminton court" 26:630):
 * select time -> invite players -> checkout. Full screen, outside the tab
 * shell, per the Figma frames (back arrow, close, progress bars).
 *
 * The court is never picked by the user: availability is aggregated by
 * amenity type and the backend assigns a specific court when the
 * reservation is created at checkout (where it is revealed).
 */
export function BookingWizardPage() {
  const { typeCode = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const types = useQuery(resourceTypesQuery);
  const membership = useQuery(membershipQuery);
  const type = types.data?.find((entry) => entry.code === typeCode);

  const [step, setStep] = useState<WizardStep>(1);
  const [date, setDate] = useState(() => todayDateKey());
  const [slots, setSlots] = useState<string[]>([]);
  const [invites, setInvites] = useState<InviteSelection>(EMPTY_INVITE_SELECTION);
  /** Alert shown on the time step after a failure bounced the user back. */
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Reservation | null>(null);
  const [inviteMore, setInviteMore] = useState(false);
  const [inviteMoreSelection, setInviteMoreSelection] =
    useState<InviteSelection>(EMPTY_INVITE_SELECTION);

  /** The live checkout hold; released when the user backs out of paying. */
  const heldIdRef = useRef<string | null>(null);
  /** Mirrors `step` for callbacks that fire after a step change. */
  const stepRef = useRef<WizardStep>(step);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  // Step changes move focus to the heading so keyboard and screen-reader
  // users land at the top of the new step.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: false });
  }, [step, inviteMore, confirmed]);

  const releaseHold = useCallback(() => {
    const id = heldIdRef.current;
    heldIdRef.current = null;
    // Fire and forget: releasing early is a courtesy, the hold TTL is the
    // backstop. Errors (already expired/cancelled) are fine.
    if (id) void api.cancelReservation(id).catch(() => undefined);
  }, []);

  const handleHoldCreated = useCallback((id: string) => {
    const previous = heldIdRef.current;
    if (previous && previous !== id) {
      // A stale hold from an earlier checkout entry; free it.
      void api.cancelReservation(previous).catch(() => undefined);
    }
    if (stepRef.current !== 3) {
      // The member backed out of checkout while the hold request was in
      // flight; release it immediately instead of squatting the slot.
      heldIdRef.current = null;
      void api.cancelReservation(id).catch(() => undefined);
      return;
    }
    heldIdRef.current = id;
  }, []);

  // Leaving the wizard by any route (browser back included) releases a
  // still-pending hold instead of squatting the slot for the TTL.
  useEffect(() => releaseHold, [releaseHold]);

  const closeWizard = useCallback(() => {
    releaseHold();
    navigate('/reserve');
  }, [releaseHold, navigate]);

  const backToTimeStep = useCallback(
    (message: string | null) => {
      releaseHold();
      void queryClient.invalidateQueries({ queryKey: ['availability', typeCode] });
      setNotice(message);
      setSlots([]);
      setStep(1);
    },
    [releaseHold, queryClient, typeCode, setNotice, setSlots, setStep],
  );

  const handleConfirmed = useCallback(
    (reservation: Reservation) => {
      heldIdRef.current = null;
      // Cache-write before the confirmation renders its navigation: the
      // reservation detail route (W4) resolves instantly from cache.
      queryClient.setQueryData(['reservations', reservation.id], {
        ...reservation,
        viewer: {
          role: 'organizer',
          status: 'confirmed',
          canInvite: true,
          canManage: true,
          canRespond: false,
        },
      });
      // The booking changed what home, the reservations list, and the
      // availability grid show.
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      void queryClient.invalidateQueries({ queryKey: ['availability', typeCode] });
      setConfirmed(reservation);
    },
    [queryClient, typeCode],
  );

  const inviteMoreMutation = useMutation({
    mutationFn: async (selection: InviteSelection) => {
      const payload = inviteesPayload(selection);
      if (!payload || !confirmed) return null;
      await api.addReservationParticipants(confirmed.id, payload);
      return api.getReservation(confirmed.id);
    },
    onSuccess: (detail) => {
      if (!detail) return;
      queryClient.setQueryData(['reservations', detail.id], detail);
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      setConfirmed(detail);
      setInviteMore(false);
      setInviteMoreSelection(EMPTY_INVITE_SELECTION);
      toast({ variant: 'success', message: 'Invites sent' });
    },
  });

  // ── Redirect return (redirect-based payment methods land back here) ──

  const resumeReservationId = searchParams.get('reservation');
  const clearResumeParams = useCallback(() => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete('reservation');
        next.delete('redirect_status');
        next.delete('payment_intent');
        next.delete('payment_intent_client_secret');
        next.delete('source_type');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // ── Frame states ──

  if (types.isPending || membership.isPending) {
    return <FullScreenLoader label="Loading booking" />;
  }

  if (types.isError || membership.isError) {
    return (
      <WizardFrame onBack={closeWizard} onClose={closeWizard}>
        <div className={styles.errorBox} role="alert">
          <p>We could not load this amenity.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (types.isError) void types.refetch();
              if (membership.isError) void membership.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      </WizardFrame>
    );
  }

  if (!type) {
    return (
      <WizardFrame onBack={closeWizard} onClose={closeWizard}>
        <EmptyState
          icon={<SearchX aria-hidden />}
          title="Amenity not found"
          description="This amenity is not open for booking."
          action={<Button onClick={closeWizard}>Back to Reserve</Button>}
        />
      </WizardFrame>
    );
  }

  if (!isEntitledMembershipStatus(membership.data.membership?.status ?? null)) {
    return (
      <WizardFrame onBack={closeWizard} onClose={closeWizard}>
        <MembershipInactiveState />
      </WizardFrame>
    );
  }

  if (type.locked) {
    return (
      <WizardFrame onBack={closeWizard} onClose={closeWizard}>
        <EmptyState
          icon={<SearchX aria-hidden />}
          title={`${type.name} is a PRO amenity`}
          description="Booking this amenity needs a PRO membership. You can change your plan from your account."
          action={<Button onClick={closeWizard}>Back to Reserve</Button>}
        />
      </WizardFrame>
    );
  }

  // ── Redirect-based payment return ──

  if (resumeReservationId && !confirmed) {
    return (
      <RedirectReturn
        type={type}
        reservationId={resumeReservationId}
        redirectStatus={searchParams.get('redirect_status')}
        onConfirmed={(reservation) => {
          clearResumeParams();
          handleConfirmed(reservation);
        }}
        onPaymentFailed={(reservation) => {
          clearResumeParams();
          if (reservation) {
            setDate(reservation.date);
            setSlots(slotsFromRange(reservation.startTime, reservation.endTime, type.slotDurationMinutes));
          }
          heldIdRef.current = null;
          setNotice(
            'Your payment was not completed and the held time was released. Pick your time to try again.',
          );
          setStep(1);
        }}
        onHoldExpired={() => {
          clearResumeParams();
          heldIdRef.current = null;
          backToTimeStep(
            'Your booking hold expired before the payment completed. If you were charged, the amount is refunded automatically.',
          );
        }}
      />
    );
  }

  // ── Confirmed: the success sheet (and post-confirm invites) ──

  if (confirmed) {
    if (inviteMore) {
      return (
        <WizardFrame
          onBack={() => setInviteMore(false)}
          onClose={() => setInviteMore(false)}
        >
          <InvitePlayersStep
            headingRef={headingRef}
            subtitle={`${formatDateHeading(confirmed.date)} · ${formatTimeRangeCompact(confirmed.startTime, confirmed.endTime)}`}
            selection={inviteMoreSelection}
            onSelectionChange={setInviteMoreSelection}
            excludeMemberIds={confirmed.participants.map((participant) => participant.memberId)}
            continueLabel="Send invites"
            continueDisabled={inviteCount(inviteMoreSelection) === 0}
            continuePending={inviteMoreMutation.isPending}
            error={
              inviteMoreMutation.isError
                ? 'We could not send those invites. Try again.'
                : null
            }
            onContinue={() => inviteMoreMutation.mutate(inviteMoreSelection)}
          />
        </WizardFrame>
      );
    }

    return (
      <div className={styles.page}>
        <ConfirmationSheet
          reservation={confirmed}
          onInviteMore={() => {
            inviteMoreMutation.reset();
            setInviteMore(true);
          }}
          onClose={closeWizard}
        />
      </div>
    );
  }

  // ── The three wizard steps ──

  const summary = selectionSummary(slots, type.slotDurationMinutes, type.hourlyRateCents);
  const stepSubtitle = summary
    ? `${formatDateHeading(date)} · ${formatTimeRangeCompact(summary.startLabel, summary.endLabel)}`
    : formatDateHeading(date);

  const goBack = () => {
    if (step === 1) {
      closeWizard();
    } else if (step === 2) {
      setStep(1);
    } else {
      // Leaving checkout abandons the hold; the slot frees up for others.
      releaseHold();
      setStep(2);
    }
  };

  return (
    <WizardFrame onBack={goBack} onClose={closeWizard} step={step}>
      {step === 1 && (
        <SelectTimeStep
          headingRef={headingRef}
          type={type}
          date={date}
          onDateChange={(next) => {
            setDate(next);
            setSlots([]);
          }}
          slots={slots}
          onSlotsChange={setSlots}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          onContinue={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <InvitePlayersStep
          headingRef={headingRef}
          subtitle={stepSubtitle}
          selection={invites}
          onSelectionChange={setInvites}
          continueLabel="Continue"
          onContinue={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <CheckoutStep
          headingRef={headingRef}
          type={type}
          date={date}
          slots={slots}
          invites={invites}
          onHoldCreated={handleHoldCreated}
          onConfirmed={handleConfirmed}
          onPickAnotherTime={backToTimeStep}
        />
      )}
    </WizardFrame>
  );
}

/**
 * The wizard chrome: back arrow, close, and the 3-segment progress bar
 * (hidden on frame-level states that are not one of the steps).
 */
function WizardFrame({
  onBack,
  onClose,
  step,
  children,
}: {
  onBack: () => void;
  onClose: () => void;
  step?: WizardStep;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <header className={styles.chrome}>
          <button type="button" className={styles.chromeButton} onClick={onBack} aria-label="Back">
            <ArrowLeft aria-hidden />
          </button>
          <button
            type="button"
            className={styles.chromeButton}
            onClick={onClose}
            aria-label="Close booking"
          >
            <X aria-hidden />
          </button>
        </header>

        {step !== undefined && (
          <div
            className={styles.progress}
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={3}
            aria-valuenow={step}
            aria-valuetext={`Step ${step} of 3: ${STEP_NAMES[step]}`}
          >
            {([1, 2, 3] as const).map((index) => (
              <span
                key={index}
                className={[
                  styles.progressSegment,
                  index === step ? styles.progressActive : '',
                  index < step ? styles.progressDone : '',
                ].join(' ')}
              />
            ))}
          </div>
        )}

        {children}
      </div>
    </div>
  );
}
