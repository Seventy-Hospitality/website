import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import type { ReservationParticipantStatus, ReservationStatus } from '../lib/api';

export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'pro';

interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  style?: StyleProp<ViewStyle>;
}

const TONES: Record<BadgeVariant, { bg: string; fg: string }> = {
  neutral: { bg: 'rgba(174, 183, 158, 0.16)', fg: colors.textMuted },
  accent: { bg: 'rgba(236, 254, 170, 0.16)', fg: colors.accent },
  success: { bg: 'rgba(190, 206, 133, 0.18)', fg: colors.success },
  danger: { bg: 'rgba(220, 161, 131, 0.18)', fg: colors.danger },
  warning: { bg: 'rgba(220, 161, 131, 0.14)', fg: colors.dangerStrong },
  pro: { bg: colors.accent, fg: colors.textOnAccent },
};

/** Uppercase pill label (statuses, "PRO", "INVITE ONLY"). */
export function Badge({ label, variant = 'neutral', style }: BadgeProps) {
  const tone = TONES[variant];
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }, style]}>
      <Text style={[styles.label, { color: tone.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const RESERVATION_TONE: Record<ReservationStatus, BadgeVariant> = {
  pending_payment: 'warning',
  confirmed: 'success',
  cancelled: 'danger',
  expired: 'neutral',
};

const PARTICIPANT_TONE: Record<ReservationParticipantStatus, BadgeVariant> = {
  confirmed: 'success',
  pending: 'warning',
  declined: 'danger',
  withdrawn: 'neutral',
};

/** Map a reservation status to a badge variant (shared by M2/M3/M4). */
export function reservationStatusVariant(status: ReservationStatus): BadgeVariant {
  return RESERVATION_TONE[status] ?? 'neutral';
}

/** Map a participant status to a badge variant (shared by M2/M4). */
export function participantStatusVariant(status: ReservationParticipantStatus): BadgeVariant {
  return PARTICIPANT_TONE[status] ?? 'neutral';
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  label: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
});
