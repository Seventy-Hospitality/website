import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { UpcomingBooking } from '../lib/api';
import { formatDateLabel } from '../lib/format';
import { colors, fonts, radius, spacing } from '../theme/tokens';

interface BookingCardProps {
  booking: UpcomingBooking;
  variant?: 'standard' | 'highlight';
  onPress?: () => void;
}

export function BookingCard({ booking, onPress, variant = 'standard' }: BookingCardProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        variant === 'highlight' ? styles.highlightCard : null,
        pressed ? styles.cardPressed : null,
      ]}
    >
      <View style={styles.row}>
        <Text style={styles.title}>
          {formatDateLabel(booking.date)} | {booking.startTime} - {booking.endTime}
        </Text>
        <Text style={styles.badge}>{booking.facilityType === 'court' ? 'Court' : 'Shower'}</Text>
      </View>
      <Text style={styles.meta}>{booking.facilityName}</Text>
      <Text style={styles.meta}>
        {booking.endTime === booking.startTime ? 'Reserved slot' : 'Upcoming reservation'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(125, 151, 124, 0.22)',
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: 'rgba(240, 246, 232, 0.06)',
  },
  highlightCard: {
    backgroundColor: 'rgba(210, 195, 166, 0.22)',
  },
  cardPressed: {
    opacity: 0.92,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.bodyBold,
    fontSize: 15,
  },
  badge: {
    color: colors.accent,
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  meta: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 12,
  },
});
