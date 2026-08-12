import { useCallback, useEffect, useState } from 'react';
import { BackHandler, ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { api, type Reservation, type ReservationViewer } from '../../lib/api';
import { PrimaryButton, useToast } from '../../components';
import { colors, fonts, spacing } from '../../theme/tokens';
import {
  formatDateHeading,
  formatTimeRangeCompact,
  selectionSummary,
  todayDateKey,
} from './booking';
import {
  isEntitledMembershipStatus,
  membershipQuery,
  resourceTypesQuery,
  useVenueTimezone,
} from './booking-data';
import {
  EMPTY_INVITE_SELECTION,
  inviteCount,
  inviteesPayload,
  type InviteSelection,
} from './invites';
import { createHoldSession, type HoldSession } from './hold-session';
import { SelectTimeStep } from './SelectTimeStep';
import { InvitePlayersStep } from './InvitePlayersStep';
import { CheckoutStep } from './CheckoutStep';
import { ConfirmationSheet } from './ConfirmationSheet';
import { MembershipInactiveState } from './MembershipInactiveState';
import { WizardFrame, type WizardStep } from './WizardFrame';

const ORGANIZER_VIEWER: ReservationViewer = {
  role: 'organizer',
  status: 'confirmed',
  canInvite: true,
  canManage: true,
  canRespond: false,
};

/**
 * The 3-step booking wizard (Figma "Booking badminton court" 26:630):
 * select time -> invite players -> checkout -> confirmation. Full screen,
 * outside the tab shell. Mirrors member-web's BookingWizardPage.
 *
 * The court is never picked by the member: availability is aggregated by
 * amenity type and the backend assigns a specific court at create (revealed
 * at checkout). The whole hold lifecycle (attempt tokens, back-out release,
 * payment lock) runs through one hold session created per wizard mount;
 * leaving the screen releases a still-pending hold.
 */
export function BookingWizardScreen() {
  const { typeCode = '' } = useLocalSearchParams<{ typeCode: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const types = useQuery(resourceTypesQuery);
  const membership = useQuery(membershipQuery);
  const type = types.data?.find((entry) => entry.code === typeCode);

  const timezone = useVenueTimezone();
  const todayKey = todayDateKey(timezone);

  const [step, setStep] = useState<WizardStep>(1);
  const [storedDate, setStoredDate] = useState(todayKey);
  // The venue zone can resolve after mount and venue midnight can pass
  // mid-session: a stored date in the venue's past is unbookable, so clamp
  // it forward to venue-today (SelectTimeStep then prunes any dead slot).
  const date = storedDate < todayKey ? todayKey : storedDate;
  const [slots, setSlots] = useState<string[]>([]);
  const [invites, setInvites] = useState<InviteSelection>(EMPTY_INVITE_SELECTION);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Reservation | null>(null);
  const [inviteMore, setInviteMore] = useState(false);
  const [inviteMoreSelection, setInviteMoreSelection] =
    useState<InviteSelection>(EMPTY_INVITE_SELECTION);
  const [paymentLocked, setPaymentLocked] = useState(false);

  const [holdSession] = useState<HoldSession>(() =>
    createHoldSession({
      // Fire and forget: releasing early is a courtesy, the hold TTL is the
      // backstop. Errors (already expired/cancelled) are fine to swallow.
      cancel: (id) => void api.cancelReservation(id).catch(() => undefined),
      onLockChange: setPaymentLocked,
    }),
  );

  // Leaving the wizard by any route releases a still-pending hold instead of
  // squatting the slot for the TTL. release() skips the cancel while a
  // payment may have captured (the money rule lives in the hold session).
  useEffect(() => () => holdSession.release(), [holdSession]);

  // Block the Android hardware back while a submitted payment may have
  // captured: there is no safe way back until the charge resolves.
  useEffect(() => {
    if (!paymentLocked) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [paymentLocked]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/reserve');
  }, [router]);

  const closeWizard = useCallback(() => {
    if (holdSession.paymentLocked) return;
    holdSession.release();
    leave();
  }, [holdSession, leave]);

  const backToTimeStep = useCallback(
    (message: string | null) => {
      holdSession.release();
      void queryClient.invalidateQueries({ queryKey: ['availability', typeCode] });
      setNotice(message);
      setSlots([]);
      setStep(1);
    },
    [holdSession, queryClient, typeCode],
  );

  const handleConfirmed = useCallback(
    (reservation: Reservation) => {
      holdSession.settle();
      // Cache-write before the confirmation renders its navigation so the
      // reservation detail route (M4) resolves instantly from cache.
      queryClient.setQueryData(['reservations', reservation.id], {
        ...reservation,
        viewer: ORGANIZER_VIEWER,
      });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      void queryClient.invalidateQueries({ queryKey: ['availability', typeCode] });
      setConfirmed(reservation);
    },
    [holdSession, queryClient, typeCode],
  );

  const inviteMoreMutation = useMutation({
    mutationFn: async (selection: InviteSelection) => {
      const payload = inviteesPayload(selection);
      if (!payload || !confirmed) return null;
      await api.addParticipants(confirmed.id, payload);
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

  const goToReservation = useCallback(() => {
    if (!confirmed) return;
    holdSession.settle();
    router.push(`/reservations/${confirmed.id}` as never);
  }, [confirmed, holdSession, router]);

  // ── Frame-level states ──

  if (types.isPending || membership.isPending) {
    return (
      <WizardFrame onBack={leave} onClose={leave}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.centerText}>Loading booking</Text>
        </View>
      </WizardFrame>
    );
  }

  if (types.isError || membership.isError) {
    return (
      <WizardFrame onBack={leave} onClose={leave}>
        <View style={styles.center}>
          <Text style={styles.centerTitle}>We could not load this amenity.</Text>
          <View style={styles.centerAction}>
            <PrimaryButton
              label="Try again"
              variant="secondary"
              onPress={() => {
                if (types.isError) void types.refetch();
                if (membership.isError) void membership.refetch();
              }}
            />
          </View>
        </View>
      </WizardFrame>
    );
  }

  if (!type) {
    return (
      <WizardFrame onBack={leave} onClose={leave}>
        <GateState
          icon="search-outline"
          title="Amenity not found"
          description="This amenity is not open for booking."
          onBack={leave}
        />
      </WizardFrame>
    );
  }

  if (!isEntitledMembershipStatus(membership.data?.status ?? null)) {
    return (
      <WizardFrame onBack={leave} onClose={leave}>
        <MembershipInactiveState />
      </WizardFrame>
    );
  }

  if (type.locked) {
    return (
      <WizardFrame onBack={leave} onClose={leave}>
        <GateState
          icon="lock-closed-outline"
          title={`${type.name} is a PRO amenity`}
          description="Booking this amenity needs a PRO membership. You can change your plan from your account."
          onBack={leave}
        />
      </WizardFrame>
    );
  }

  // ── Confirmed: the success sheet (and post-confirm invites) ──

  if (confirmed) {
    if (inviteMore) {
      return (
        <WizardFrame onBack={() => setInviteMore(false)} onClose={() => setInviteMore(false)}>
          <InvitePlayersStep
            subtitle={`${formatDateHeading(confirmed.date)} · ${formatTimeRangeCompact(
              confirmed.startTime,
              confirmed.endTime,
            )}`}
            selection={inviteMoreSelection}
            onSelectionChange={setInviteMoreSelection}
            excludeMemberIds={confirmed.participants.map((participant) => participant.memberId)}
            continueLabel="Send invites"
            continueDisabled={inviteCount(inviteMoreSelection) === 0}
            continuePending={inviteMoreMutation.isPending}
            error={inviteMoreMutation.isError ? 'We could not send those invites. Try again.' : null}
            onContinue={() => inviteMoreMutation.mutate(inviteMoreSelection)}
          />
        </WizardFrame>
      );
    }

    return (
      <View style={styles.confirmedBackground}>
        <View style={styles.confirmedGlyph}>
          <Ionicons name="checkmark" size={44} color={colors.accent} />
        </View>
        <ConfirmationSheet
          reservation={confirmed}
          onInviteMore={() => {
            inviteMoreMutation.reset();
            setInviteMore(true);
          }}
          onGoToReservation={goToReservation}
          onClose={closeWizard}
        />
      </View>
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
      if (holdSession.paymentLocked) return;
      // Leaving checkout abandons the hold; the slot frees for others.
      holdSession.release();
      setStep(2);
    }
  };

  return (
    <WizardFrame onBack={goBack} onClose={closeWizard} step={step} chromeDisabled={paymentLocked}>
      {step === 1 ? (
        <SelectTimeStep
          type={type}
          timezone={timezone}
          date={date}
          onDateChange={(next) => {
            setStoredDate(next);
            setSlots([]);
          }}
          slots={slots}
          onSlotsChange={setSlots}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          onContinue={() => setStep(2)}
        />
      ) : null}

      {step === 2 ? (
        <InvitePlayersStep
          subtitle={stepSubtitle}
          selection={invites}
          onSelectionChange={setInvites}
          continueLabel="Continue"
          onContinue={() => setStep(3)}
        />
      ) : null}

      {step === 3 ? (
        <CheckoutStep
          type={type}
          date={date}
          slots={slots}
          invites={invites}
          beginHoldAttempt={() => holdSession.beginAttempt()}
          onHoldCreated={(id, attempt) => holdSession.holdCreated(id, attempt)}
          onPaymentLock={(locked) => holdSession.setPaymentLocked(locked)}
          onConfirmed={handleConfirmed}
          onPickAnotherTime={backToTimeStep}
        />
      ) : null}
    </WizardFrame>
  );
}

function GateState({
  icon,
  title,
  description,
  onBack,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  onBack: () => void;
}) {
  return (
    <View style={styles.center}>
      <View style={styles.gateGlyph}>
        <Ionicons name={icon} size={26} color={colors.accent} />
      </View>
      <Text style={styles.centerTitle}>{title}</Text>
      <Text style={styles.centerText}>{description}</Text>
      <View style={styles.centerAction}>
        <PrimaryButton label="Back to Reserve" onPress={onBack} />
      </View>
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
  gateGlyph: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceOverlay,
    marginBottom: spacing.xs,
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
    lineHeight: 20,
    maxWidth: 280,
  },
  centerAction: {
    marginTop: spacing.md,
    alignSelf: 'stretch',
    paddingHorizontal: spacing.md,
  },
  confirmedBackground: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  confirmedGlyph: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceOverlay,
  },
});
