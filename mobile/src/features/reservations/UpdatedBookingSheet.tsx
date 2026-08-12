import { StyleSheet, Text, View } from 'react-native';
import type { Reservation, ReservationParticipantStatus } from '../../lib/api';
import { Avatar, Badge, participantStatusVariant, PrimaryButton, Sheet } from '../../components';
import { colors, fonts, spacing } from '../../theme/tokens';
import {
  bookingRefLabel,
  formatAmountWithCents,
  formatDateFull,
  formatTimeRangeCompact,
  resourceNoun,
} from '../reserve/booking';
import { memberDisplayName } from '../reserve/invites';
import { ReservationSummaryCard } from '../reserve/ReservationSummaryCard';
import type { RescheduleMoney } from './reservation-policy';

const STATUS_LABELS: Record<ReservationParticipantStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

/**
 * The post-edit success sheet (Figma confirm-changes-modal 205:19718): the
 * updated booking details (ref persists, amount paid updated), a refund line
 * for a shrink, and the roster where confirmed guests are reset to PENDING
 * with the "will need to reaccept" warning. Mirrors member-web's
 * UpdatedBookingSheet.
 */
export function UpdatedBookingSheet({
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
      <View style={styles.body}>
        <Text style={styles.title}>Your {noun} booking was updated</Text>
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

        {money?.kind === 'refund' ? (
          <Text style={styles.caption}>
            {formatAmountWithCents(money.refundCents)} is being refunded to your card
          </Text>
        ) : null}

        <View style={styles.rosterHead}>
          <Text style={styles.sectionLabel}>
            Players <Text style={styles.rosterCount}>{roster.length}</Text>
          </Text>
          {pendingCount > 0 ? (
            <Text style={styles.resetWarning} accessibilityRole="alert">
              will need to reaccept their invitations
            </Text>
          ) : null}
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
          <PrimaryButton label="Go to reservation" variant="ghost" onPress={onClose} />
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
    flexWrap: 'wrap',
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
  },
  resetWarning: {
    color: colors.dangerStrong,
    fontFamily: fonts.body,
    fontSize: 12,
    flexShrink: 1,
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
