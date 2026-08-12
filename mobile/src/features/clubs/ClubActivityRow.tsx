import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ClubActivityItem } from '../../lib/api';
import { Badge } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { formatTimeRangeCompact } from '../reserve/booking';
import { activityDayLabel, isLinkableActivity, isUpcomingActivity, playersCountLabel } from './clubs-lib';

/**
 * One group-activity row (Figma club-detail 105:5927): the day, the time range,
 * and "<resource> · N players", with an Upcoming / Cancelled badge. Only rows
 * the viewer participates in deep-link to the reservation detail (the detail is
 * participation-scoped and 404s for everyone else). No avatar cluster: the
 * activity endpoint serves a reduced, non-participant projection.
 */
export function ClubActivityRow({ item, onPress }: { item: ClubActivityItem; onPress: () => void }) {
  const badge = isUpcomingActivity(item)
    ? { label: 'Upcoming', variant: 'success' as const }
    : item.status === 'cancelled'
      ? { label: 'Cancelled', variant: 'danger' as const }
      : null;

  const timeRange = formatTimeRangeCompact(item.startTime, item.endTime);
  const meta = `${item.resource.name} · ${playersCountLabel(item.confirmedCount)}`;
  const label = `${activityDayLabel(item.date)}, ${timeRange}, ${meta}${badge ? `, ${badge.label}` : ''}`;

  const body = (
    <>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          <Text style={styles.day}>{activityDayLabel(item.date)}</Text>
          {'  '}
          {timeRange}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      {badge ? <Badge label={badge.label} variant={badge.variant} /> : null}
    </>
  );

  if (isLinkableActivity(item)) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
      >
        {body}
      </Pressable>
    );
  }

  return (
    <View accessibilityLabel={label} style={styles.row}>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: {
    opacity: 0.9,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.bodyMedium,
    fontSize: 15,
  },
  day: {
    fontFamily: fonts.bodyBold,
  },
  meta: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
});
