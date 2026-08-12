import { StyleSheet, Text, View } from 'react-native';
import type { ClubInvitation } from '../../lib/api';
import { Avatar, PrimaryButton } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { memberCountLabel } from './clubs-lib';

interface ClubInvitationCardProps {
  invitation: ClubInvitation;
  onAccept: () => void;
  onDecline: () => void;
  /** This card's response is in flight. */
  pending: boolean;
  /** Any response (this or another card) is in flight. */
  disabled: boolean;
}

/**
 * A pending club invitation on the clubs tab (mirrors member-web's
 * InvitationCard): who invited you, the club, and Accept / Decline. Responses
 * run through M2's useRespondToClubInvitation so the home feed and this list
 * stay in sync.
 */
export function ClubInvitationCard({
  invitation,
  onAccept,
  onDecline,
  pending,
  disabled,
}: ClubInvitationCardProps) {
  const inviterName = invitation.invitedBy
    ? `${invitation.invitedBy.firstName} ${invitation.invitedBy.lastName}`.trim()
    : 'A member';

  return (
    <View style={styles.card}>
      <Text style={styles.inviter}>
        <Text style={styles.inviterName}>{inviterName}</Text> invited you
      </Text>
      <View style={styles.clubRow}>
        <Avatar name={invitation.club.name} src={invitation.club.coverImageUrl} size="md" />
        <View style={styles.clubText}>
          <Text style={styles.clubName} numberOfLines={1}>
            {invitation.club.name}
          </Text>
          <Text style={styles.clubMeta}>{memberCountLabel(invitation.club.memberCount)}</Text>
        </View>
      </View>
      <View
        style={styles.actions}
        accessibilityRole="none"
        accessibilityLabel={`Respond to the ${invitation.club.name} invitation`}
      >
        <View style={styles.actionButton}>
          <PrimaryButton
            label="Accept"
            accessibilityLabel={`Accept the ${invitation.club.name} invitation`}
            loading={pending}
            disabled={disabled && !pending}
            onPress={onAccept}
          />
        </View>
        <View style={styles.actionButton}>
          <PrimaryButton
            label="Decline"
            variant="ghost"
            accessibilityLabel={`Decline the ${invitation.club.name} invitation`}
            disabled={disabled}
            onPress={onDecline}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  inviter: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  inviterName: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
  },
  clubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  clubText: {
    flex: 1,
    gap: 2,
  },
  clubName: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 18,
  },
  clubMeta: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionButton: {
    flex: 1,
  },
});
