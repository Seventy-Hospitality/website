import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  type Reservation,
  type ReservationViewer,
  type ResourceTypeSummary,
} from '../../lib/api';
import { EmptyStateView, PrimaryButton } from '../../components';
import { colors, fonts, spacing } from '../../theme/tokens';
import {
  isEntitledMembershipStatus,
  membershipQuery,
  resourceTypesQuery,
  useVenueTimezone,
} from '../reserve/booking-data';
import { createHoldSession, type HoldSession } from '../reserve/hold-session';
import { MembershipInactiveState } from '../reserve/MembershipInactiveState';
import { SelectTimeStep } from '../reserve/SelectTimeStep';
import { WizardFrame, type WizardStep } from '../reserve/WizardFrame';
import { ConfirmChangesStep } from './ConfirmChangesStep';
import { UpdatedBookingSheet } from './UpdatedBookingSheet';
import {
  hasReservationStarted,
  isSelectionChanged,
  reservationSlots,
  type RescheduleMoney,
} from './reservation-policy';
import { reservationQuery } from './reservations-data';

type ReservationDetail = Reservation & { viewer: ReservationViewer };

const EDIT_STEP_NAMES: Record<1 | 2, string> = {
  1: 'Choose a new time',
  2: 'Confirm changes',
};

/**
 * The 2-step edit/reschedule wizard (Figma "Editing reservation" 152:12072:
 * edit-booking 325:15083/325:15177, confirm-changes 205:19481, updated modal
 * 205:19718). Organizer-only, on confirmed reservations.
 *
 * Step 1 reuses M3's SelectTimeStep with the reservation's OWN slots
 * pre-selected and treated as available to itself (excludeReservationId);
 * Continue stays disabled until the selection actually changes. Step 2
 * confirms the money delta (shrink applies immediately + refunds; grow
 * collects the delta with the shared PaymentSheet money-safety pattern).
 */
export function RescheduleWizardScreen({ reservationId }: { reservationId: string }) {
  const router = useRouter();

  const detail = useQuery(reservationQuery(reservationId));
  const types = useQuery(resourceTypesQuery);
  const membership = useQuery(membershipQuery);

  const backToDetail = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(`/reservations/${reservationId}` as never);
  }, [router, reservationId]);

  if (detail.isPending || types.isPending || membership.isPending) {
    return (
      <EditGuardFrame onExit={backToDetail}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.centerText}>Loading reservation</Text>
        </View>
      </EditGuardFrame>
    );
  }

  if (detail.isError || types.isError || membership.isError) {
    const error = detail.error ?? types.error ?? membership.error;
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      return (
        <EditGuardFrame onExit={backToDetail}>
          <GateState
            title="Reservation not found"
            description="This reservation does not exist, was removed, or you are not part of it."
            actionLabel="Back to home"
            onPress={() => router.replace('/(tabs)')}
          />
        </EditGuardFrame>
      );
    }
    return (
      <EditGuardFrame onExit={backToDetail}>
        <View style={styles.center}>
          <Text style={styles.centerTitle}>We could not load this reservation.</Text>
          <View style={styles.centerAction}>
            <PrimaryButton
              label="Try again"
              variant="secondary"
              onPress={() => {
                if (detail.isError) void detail.refetch();
                if (types.isError) void types.refetch();
                if (membership.isError) void membership.refetch();
              }}
            />
          </View>
        </View>
      </EditGuardFrame>
    );
  }

  const reservation = detail.data as ReservationDetail;
  const type = types.data.find((entry) => entry.code === reservation.typeCode);

  if (!reservation.viewer?.canManage) {
    return (
      <EditGuardFrame onExit={backToDetail}>
        <GateState
          title="Only the organizer can edit"
          description="Ask the member who booked this reservation to change it."
          actionLabel="Back to reservation"
          onPress={backToDetail}
        />
      </EditGuardFrame>
    );
  }

  if (!isEntitledMembershipStatus(membership.data?.status ?? null)) {
    return (
      <EditGuardFrame onExit={backToDetail}>
        <MembershipInactiveState />
      </EditGuardFrame>
    );
  }

  if (reservation.status !== 'confirmed' || hasReservationStarted(reservation) || !type) {
    return (
      <EditGuardFrame onExit={backToDetail}>
        <GateState
          title="This reservation can no longer be edited"
          description={
            reservation.status !== 'confirmed'
              ? 'Only confirmed upcoming bookings can be rescheduled.'
              : 'This booking has already started.'
          }
          actionLabel="Back to reservation"
          onPress={backToDetail}
        />
      </EditGuardFrame>
    );
  }

  return <EditWizard key={reservation.id} detail={reservation} type={type} />;
}

/** Chrome-only frame for the guard states (no progress bar). */
function EditGuardFrame({ onExit, children }: { onExit: () => void; children: React.ReactNode }) {
  return (
    <WizardFrame onBack={onExit} onClose={onExit}>
      {children}
    </WizardFrame>
  );
}

function EditWizard({ detail, type }: { detail: ReservationDetail; type: ResourceTypeSummary }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const timezone = useVenueTimezone();

  const currentSlots = reservationSlots(detail, type.slotDurationMinutes);

  const [step, setStep] = useState<WizardStep>(1);
  const [date, setDate] = useState(detail.date);
  const [slots, setSlots] = useState<string[]>(currentSlots);
  const [notice, setNotice] = useState<string | null>(null);
  const [updated, setUpdated] = useState<{ reservation: Reservation; money: RescheduleMoney | null } | null>(
    null,
  );
  const [paymentLocked, setPaymentLocked] = useState(false);

  /**
   * M3's hold session, adapted to the reschedule contract: attempt tokens
   * still fence out-of-order PATCH responses and the payment lock still
   * freezes the chrome once a delta payment may have captured. The cancel is
   * a NO-OP by design: there is no client-cancel endpoint for a parked change
   * (DELETE cancels the whole reservation), and none is needed; an unpaid
   * change lapses at its TTL and any newer PATCH supersedes it server-side.
   */
  const [holdSession] = useState<HoldSession>(() =>
    createHoldSession({ cancel: () => undefined, onLockChange: setPaymentLocked }),
  );
  useEffect(() => () => holdSession.release(), [holdSession]);

  // Block the Android hardware back while a submitted delta payment may have
  // captured: there is no safe way back until the charge resolves.
  useEffect(() => {
    if (!paymentLocked) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [paymentLocked]);

  const dirty = isSelectionChanged(detail, date, slots, type.slotDurationMinutes);

  const goToDetail = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(`/reservations/${detail.id}` as never);
  }, [router, detail.id]);

  const closeWizard = useCallback(() => {
    if (holdSession.paymentLocked) return;
    holdSession.release();
    goToDetail();
  }, [holdSession, goToDetail]);

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

  // ── Success: the updated-booking sheet ──

  if (updated) {
    return (
      <View style={styles.successBackground}>
        <UpdatedBookingSheet
          reservation={updated.reservation}
          money={updated.money}
          onInviteMore={() => router.replace(`/reservations/${detail.id}/invite` as never)}
          onClose={goToDetail}
        />
      </View>
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
    <WizardFrame
      onBack={goBack}
      onClose={closeWizard}
      step={step}
      steps={2}
      stepName={EDIT_STEP_NAMES[step === 2 ? 2 : 1]}
      chromeDisabled={paymentLocked}
    >
      {step === 1 ? (
        <SelectTimeStep
          type={type}
          timezone={timezone}
          title="Edit booking"
          date={date}
          onDateChange={(next) => {
            setDate(next);
            setSlots(next === detail.date ? currentSlots : []);
          }}
          slots={slots}
          onSlotsChange={setSlots}
          excludeReservationId={detail.id}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          continueDisabled={!dirty}
          onContinue={() => setStep(2)}
        />
      ) : (
        <ConfirmChangesStep
          detail={detail}
          type={type}
          date={date}
          slots={slots}
          holdSession={holdSession}
          onApplied={handleApplied}
          onBackToTime={backToTimeStep}
        />
      )}
    </WizardFrame>
  );
}

function GateState({
  title,
  description,
  actionLabel,
  onPress,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.gate}>
      <EmptyStateView title={title} description={description} />
      <PrimaryButton label={actionLabel} onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  centerTitle: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 18,
    textAlign: 'center',
  },
  centerText: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
    textAlign: 'center',
  },
  centerAction: {
    marginTop: spacing.md,
    alignSelf: 'stretch',
    paddingHorizontal: spacing.md,
  },
  gate: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  successBackground: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
