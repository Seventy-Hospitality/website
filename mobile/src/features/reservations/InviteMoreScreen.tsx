import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { EmptyStateView, PrimaryButton, useToast } from '../../components';
import { colors, fonts, spacing } from '../../theme/tokens';
import { formatDateHeading, formatTimeRangeCompact } from '../reserve/booking';
import {
  EMPTY_INVITE_SELECTION,
  inviteCount,
  inviteesPayload,
  type InviteSelection,
} from '../reserve/invites';
import { InvitePlayersStep } from '../reserve/InvitePlayersStep';
import { WizardFrame } from '../reserve/WizardFrame';
import { reservationQuery } from './reservations-data';

/**
 * "Invite more players" from the reservation detail: M3's invite step (member
 * search + club "Add all" chips) run full-screen against an existing
 * reservation. POST /api/reservations/:id/participants; permission is the
 * backend's canInvite (organizer + confirmed participants, active
 * reservations). Mirrors member-web's InviteParticipantsPage, native.
 */
export function InviteMoreScreen({ reservationId }: { reservationId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const detail = useQuery(reservationQuery(reservationId));
  const [selection, setSelection] = useState<InviteSelection>(EMPTY_INVITE_SELECTION);

  const backToDetail = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(`/reservations/${reservationId}` as never);
  }, [router, reservationId]);

  const invite = useMutation({
    mutationFn: async (picked: InviteSelection) => {
      const payload = inviteesPayload(picked);
      if (!payload) return null;
      await api.addParticipants(reservationId, payload);
      return api.getReservation(reservationId);
    },
    onSuccess: (fresh) => {
      if (fresh) {
        queryClient.setQueryData(['reservations', reservationId], fresh);
        void queryClient.invalidateQueries({ queryKey: ['reservations'] });
        void queryClient.invalidateQueries({ queryKey: ['home'] });
      }
      toast({ variant: 'success', message: 'Invites sent' });
      backToDetail();
    },
  });

  if (detail.isPending) {
    return (
      <WizardFrame onBack={backToDetail} onClose={backToDetail}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.centerText}>Loading reservation</Text>
        </View>
      </WizardFrame>
    );
  }

  if (detail.isError) {
    const error = detail.error;
    // The backend answers 404/403 for outsiders on purpose (a reservation you
    // are not part of looks exactly like one that does not exist); that is a
    // terminal gate. A transient 5xx or network drop is retryable in place, so
    // do not falsely tell an entitled member they are not part of it.
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      return (
        <WizardFrame onBack={backToDetail} onClose={backToDetail}>
          <View style={styles.gate}>
            <EmptyStateView
              title="Reservation not found"
              description="This reservation does not exist, was removed, or you are not part of it."
            />
            <PrimaryButton label="Back to home" onPress={() => router.replace('/(tabs)')} />
          </View>
        </WizardFrame>
      );
    }
    return (
      <WizardFrame onBack={backToDetail} onClose={backToDetail}>
        <View style={styles.center}>
          <Text style={styles.centerTitle}>We could not load this reservation.</Text>
          <View style={styles.centerAction}>
            <PrimaryButton label="Try again" variant="secondary" onPress={() => void detail.refetch()} />
          </View>
        </View>
      </WizardFrame>
    );
  }

  const reservation = detail.data;
  if (!reservation.viewer?.canInvite) {
    return (
      <WizardFrame onBack={backToDetail} onClose={backToDetail}>
        <View style={styles.gate}>
          <EmptyStateView
            title="Inviting is not available"
            description="Only the organizer and confirmed players can invite to an upcoming reservation."
          />
          <PrimaryButton label="Back to reservation" onPress={backToDetail} />
        </View>
      </WizardFrame>
    );
  }

  return (
    <WizardFrame onBack={backToDetail} onClose={backToDetail}>
      <InvitePlayersStep
        subtitle={`${formatDateHeading(reservation.date)} · ${formatTimeRangeCompact(
          reservation.startTime,
          reservation.endTime,
        )}`}
        selection={selection}
        onSelectionChange={setSelection}
        excludeMemberIds={reservation.participants
          .filter((row) => row.status === 'pending' || row.status === 'confirmed')
          .map((row) => row.memberId)}
        continueLabel="Send invites"
        continueDisabled={inviteCount(selection) === 0}
        continuePending={invite.isPending}
        error={invite.isError ? 'We could not send those invites. Try again.' : null}
        onContinue={() => invite.mutate(selection)}
      />
    </WizardFrame>
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
  centerText: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  centerTitle: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 18,
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
});
