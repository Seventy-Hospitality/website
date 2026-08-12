/**
 * Billing screen (Figma billing 107:10434), native. Reads the billing overview
 * (['billing']) and renders: the current-membership card with its status line,
 * price, default payment method (Edit) and a Change/Cancel-membership entry,
 * followed by the billing history grouped by month (each expandable to that
 * month's transactions). Mirrors member-web's BillingPage.
 */
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import type { BillingOverview, MembershipSummary, PaymentMethodSummary } from '../../lib/api';
import { EmptyStateView, PrimaryButton, Skeleton } from '../../components';
import { useVenueTimezone } from '../reserve';
import { colors, fonts, radius, spacing, typography } from '../../theme/tokens';
import { AccountFrame } from './AccountFrame';
import { billingQuery } from './account-data';
import {
  canCancelMembership,
  canChangeMembership,
  formatAmount,
  membershipPriceSuffix,
  membershipStatusLine,
  paymentMethodLabel,
} from './account-lib';
import { BillingMonthRow } from './BillingMonthRow';

export function BillingScreen() {
  const billing = useQuery(billingQuery);
  const timezone = useVenueTimezone();

  return (
    <AccountFrame
      title="Billing"
      backLabel="Back to account"
      backTo="/(tabs)/account"
      refreshing={billing.isRefetching && !billing.isPending}
      onRefresh={() => void billing.refetch()}
    >
      {billing.isPending ? (
        <View accessibilityLabel="Loading your billing" style={styles.loading}>
          <Skeleton height={150} borderRadius={radius.lg} />
          <Skeleton height={72} borderRadius={radius.lg} />
          <Skeleton height={72} borderRadius={radius.lg} />
        </View>
      ) : billing.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load your billing.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void billing.refetch()} />
        </View>
      ) : (
        <BillingView data={billing.data} timezone={timezone} />
      )}
    </AccountFrame>
  );
}

function BillingView({ data, timezone }: { data: BillingOverview; timezone: string }) {
  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Membership</Text>
        <MembershipCard
          membership={data.membership}
          defaultPaymentMethod={data.defaultPaymentMethod}
          timezone={timezone}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Billing history</Text>
        {data.months.length === 0 ? (
          <EmptyStateView
            title="No transactions yet"
            description="Your membership and booking payments will show up here."
          />
        ) : (
          <View style={styles.history}>
            {data.months.map((month) => (
              <BillingMonthRow key={month.month} month={month} timezone={timezone} />
            ))}
          </View>
        )}
      </View>
    </>
  );
}

function MembershipCard({
  membership,
  defaultPaymentMethod,
  timezone,
}: {
  membership: MembershipSummary | null;
  defaultPaymentMethod: PaymentMethodSummary | null;
  timezone: string;
}) {
  const router = useRouter();

  if (!membership) {
    return (
      <View style={styles.card}>
        <Text style={styles.noMembershipTitle}>You do not have a membership.</Text>
        <Text style={styles.noMembershipBody}>
          Contact the club if you would like to restart your membership.
        </Text>
      </View>
    );
  }

  const plan = membership.plan;
  const actionLabel = canChangeMembership(membership)
    ? 'Change membership'
    : canCancelMembership(membership)
      ? 'Cancel membership'
      : null;

  return (
    <View style={styles.card}>
      <View style={styles.planRow}>
        <Text style={styles.planName}>{plan?.name ?? 'Membership'}</Text>
        {plan ? (
          <Text style={styles.planPrice}>
            {formatAmount(plan.amountCents)}
            <Text style={styles.planPeriod}>{membershipPriceSuffix(plan.interval)}</Text>
          </Text>
        ) : null}
      </View>
      <Text style={styles.planStatus}>{membershipStatusLine(membership, timezone)}</Text>

      <View style={styles.divider} />

      <View style={styles.paymentRow}>
        {defaultPaymentMethod ? (
          <>
            <View style={styles.brandChip}>
              <Text style={styles.brandChipText}>{defaultPaymentMethod.brand.toUpperCase()}</Text>
            </View>
            <Text style={styles.cardText} numberOfLines={1}>
              {paymentMethodLabel(defaultPaymentMethod)}
            </Text>
            <Text
              accessibilityRole="button"
              accessibilityLabel="Edit payment method"
              onPress={() => router.push('/account/payment-method')}
              style={styles.paymentAction}
            >
              Edit
            </Text>
          </>
        ) : (
          <>
            <Ionicons name="card-outline" size={18} color={colors.textMuted} />
            <Text style={styles.cardText}>No payment method on file</Text>
            <Text
              accessibilityRole="button"
              accessibilityLabel="Add payment method"
              onPress={() => router.push('/account/payment-method')}
              style={styles.paymentAction}
            >
              Add
            </Text>
          </>
        )}
      </View>

      {actionLabel ? (
        <>
          <View style={styles.divider} />
          <ActionRow label={actionLabel} onPress={() => router.push('/account/change-membership')} />
        </>
      ) : null}
    </View>
  );
}

function ActionRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Text
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.changeRow}
    >
      {label}
      {'  '}›
    </Text>
  );
}

const styles = StyleSheet.create({
  loading: {
    gap: spacing.md,
  },
  errorBox: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  errorText: {
    ...typography.body,
    color: colors.text,
  },
  section: {
    gap: spacing.sm,
  },
  sectionLabel: {
    ...typography.label,
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  noMembershipTitle: {
    ...typography.h3,
    color: colors.text,
  },
  noMembershipBody: {
    ...typography.body,
    color: colors.textMuted,
  },
  planRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  planName: {
    ...typography.h2,
    color: colors.text,
    flexShrink: 1,
  },
  planPrice: {
    fontFamily: fonts.displayBold,
    fontSize: 22,
    color: colors.accent,
  },
  planPeriod: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textMuted,
  },
  planStatus: {
    ...typography.body,
    color: colors.textMuted,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  brandChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceOverlay,
  },
  brandChipText: {
    color: colors.text,
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  cardText: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  paymentAction: {
    color: colors.accent,
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  },
  changeRow: {
    color: colors.accent,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
  },
  history: {
    gap: spacing.sm,
  },
});
