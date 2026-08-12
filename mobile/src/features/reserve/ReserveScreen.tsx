import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ResourceTypeSummary } from '../../lib/api';
import { AppScreen, Badge, EmptyStateView, PrimaryButton, Skeleton } from '../../components';
import { colors, fonts, spacing } from '../../theme/tokens';
import { availabilityCountLabel, formatAmount } from './booking';
import { isEntitledMembershipStatus, membershipQuery, resourceTypesQuery } from './booking-data';
import { MembershipInactiveState } from './MembershipInactiveState';
import { ResourceTypeTile } from './ResourceTypeIcon';

/**
 * The Reserve tab (Figma browse-courts 7:2331): amenity types with their
 * resource count and hourly rate. A tier-gated amenity the member cannot
 * book renders locked with the PRO badge. Tapping a bookable type opens the
 * booking wizard for it. Mirrors member-web's ReservePage, native.
 */
export function ReserveScreen() {
  const types = useQuery(resourceTypesQuery);
  const membership = useQuery(membershipQuery);

  const membershipStatus = membership.data?.status ?? null;
  const lapsed = membership.isSuccess && !isEntitledMembershipStatus(membershipStatus);

  const refreshing = types.isRefetching || membership.isRefetching;
  const onRefresh = () => {
    void types.refetch();
    void membership.refetch();
  };

  return (
    <AppScreen refreshing={refreshing} onRefresh={onRefresh}>
      <View style={styles.header}>
        <Text style={styles.title}>Reserve</Text>
        <Text style={styles.subtitle}>Book courts and amenities in advance</Text>
      </View>

      {lapsed ? (
        <MembershipInactiveState />
      ) : types.isPending || membership.isPending ? (
        <View style={styles.list} accessibilityLabel="Loading amenities">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={78} borderRadius={16} />
          ))}
        </View>
      ) : types.isError || membership.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load the amenities.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={onRefresh} />
        </View>
      ) : types.data.length === 0 ? (
        <EmptyStateView
          title="Nothing to book yet"
          description="The club has not opened any amenities for booking."
        />
      ) : (
        <View style={styles.list}>
          {types.data.map((type) => (
            <ResourceTypeRow key={type.code} type={type} />
          ))}
        </View>
      )}
    </AppScreen>
  );
}

function ResourceTypeRow({ type }: { type: ResourceTypeSummary }) {
  const router = useRouter();

  const inner = (
    <>
      <ResourceTypeTile code={type.code} />
      <View style={styles.rowText}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {type.name}
          </Text>
          {type.locked ? <Badge label="PRO" variant="pro" /> : null}
        </View>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {availabilityCountLabel(type.name, type.resourceCount)}
        </Text>
      </View>
      <View style={styles.rowTrailing}>
        <Text style={styles.rowRate}>{formatAmount(type.hourlyRateCents)}/hr</Text>
        <Ionicons
          name={type.locked ? 'lock-closed' : 'chevron-forward'}
          size={18}
          color={type.locked ? colors.textSubtle : colors.textMuted}
        />
      </View>
    </>
  );

  if (type.locked) {
    return (
      <View
        style={[styles.row, styles.rowLocked]}
        accessibilityRole="text"
        accessibilityLabel={`${type.name}, requires a PRO membership, ${formatAmount(
          type.hourlyRateCents,
        )} per hour`}
      >
        {inner}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Book ${type.name}, ${availabilityCountLabel(
        type.name,
        type.resourceCount,
      )}, ${formatAmount(type.hourlyRateCents)} per hour`}
      onPress={() => router.push(`/reserve/${encodeURIComponent(type.code)}`)}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      {inner}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.xs,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayHeavy,
    fontSize: 30,
  },
  subtitle: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  list: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 16,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowPressed: {
    opacity: 0.9,
  },
  rowLocked: {
    opacity: 0.7,
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowTitle: {
    flexShrink: 1,
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 16,
  },
  rowSubtitle: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  rowTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowRate: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  },
  errorBox: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  errorText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
});
