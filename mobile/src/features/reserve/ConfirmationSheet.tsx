import { StyleSheet, Text, View } from 'react-native';
import type { Reservation, ReservationParticipantStatus } from '../../lib/api';
import {
  Avatar,
  Badge,
  participantStatusVariant,
  PrimaryButton,
  Sheet,
} from '../../components';
import { colors, fonts, spacing } from '../../theme/tokens';
import {
  bookingRefLabel,
  formatAmountWithCents,
  formatDateFull,
  formatTimeRangeCompact,
  resourceNoun,
} from './booking';
import { memberDisplayName } from './invites';
import { ReservationSummaryCard } from './ReservationSummaryCard';

const STATUS_LABELS: Record<ReservationParticipantStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

export interface ConfirmationSheetProps {
  reservation: Reservation;
  onInviteMore: () => void;
  onGoToReservation: () => void;
  onClose: () => void;
}

/**
 * The success sheet (Figma confirmation 7:2772): booking details with the
 * booking ref and amount paid, the player roster with per-player statuses,
 * and "Invite more players" / "Go to reservation". Built on the kit Sheet.
 * The reservation detail route belongs to M4; the link works either way.
 */
export function ConfirmationSheet({
  reservation,
  onInviteMore,
  onGoToReservation,
  onClose,
}: ConfirmationSheetProps) {
  const noun = resourceNoun(reservation.typeName);
  // Removed/declined guests still exist as rows; show everyone on (or
  // pending for) the booking.
  const roster = reservation.participants.filter(
    (participant) => participant.status === 'confirmed' || participant.status === 'pending',
  );

  return (
    <Sheet open onClose={onClose} title="Booking confirmed">
      <View style={styles.body}>
        <Text style={styles.title}>Your {noun} booking is confirmed</Text>
        <Text style={styles.caption}>A confirmation has been sent to your email</Text>

        <ReservationSummaryCard
          typeCode={reservation.typeCode}
          typeName={reservation.typeName}
          resourceName={reservation.resource.name}
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

        <View style={styles.rosterHead}>
          <Text style={styles.sectionLabel}>Players</Text>
          <Text style={styles.rosterCount}>{roster.length}</Text>
        </View>

        <View style={styles.roster}>
          {roster.map((participant) => {
            const name = memberDisplayName(participant);
            return (
              <View key={participant.memberId} style={styles.player}>
                <Avatar name={name} size="sm" />
                <Text style={styles.playerName} numberOfLines={1}>
                  {name}
                </Text>
                <Badge
                  label={STATUS_LABELS[participant.status]}
                  variant={participantStatusVariant(participant.status)}
                />
              </View>
            );
          })}
        </View>

        <View style={styles.actions}>
          <PrimaryButton label="Invite more players" onPress={onInviteMore} />
          <PrimaryButton label="Go to reservation" variant="ghost" onPress={onGoToReservation} />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 20,
  },
  caption: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
    marginTop: -spacing.xs,
  },
  rosterHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  rosterCount: {
    color: colors.textSubtle,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
  },
  roster: {
    gap: spacing.sm,
  },
  player: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  playerName: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
  },
  actions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
