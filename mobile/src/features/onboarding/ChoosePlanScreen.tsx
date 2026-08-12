/**
 * Onboarding step 1 (Figma onboarding/choose-membership 68:1559): billing
 * period toggle, the Member plan card with price + feature bullets, the
 * invite-only Pro tier rendered locked, Continue to checkout. Native mirror of
 * member-web ChoosePlanPage.
 *
 * Cards are derived from whatever GET /api/plans returns: one card per tier,
 * re-priced per the selected period (plan-pricing.ts).
 */
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '../../lib/session';
import type { BillingInterval } from '../../lib/api';
import { AppScreen } from '../../components/AppScreen';
import { Badge } from '../../components/Badge';
import { PrimaryButton } from '../../components/PrimaryButton';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Skeleton } from '../../components/Skeleton';
import { colors, fonts, radius, spacing, typography } from '../../theme/tokens';
import {
  PERIOD_LABELS,
  billingCaption,
  defaultBillingPeriod,
  formatAmount,
  listBillingPeriods,
  periodSuffix,
  planCardsForPeriod,
  tierLabel,
  type PlanCard,
} from './plan-pricing';
import { plansQuery } from './queries';

export function ChoosePlanScreen() {
  const router = useRouter();
  const { emailVerified, signOut } = useSession();
  const plans = useQuery(plansQuery);
  const [chosenPeriod, setChosenPeriod] = useState<BillingInterval | null>(null);
  const [chosenTier, setChosenTier] = useState<string | null>(null);
  const signOutMutation = useMutation({ mutationFn: signOut });

  const rows = plans.data ?? [];
  const periods = listBillingPeriods(rows);
  const period =
    chosenPeriod !== null && periods.includes(chosenPeriod)
      ? chosenPeriod
      : defaultBillingPeriod(rows);
  const cards = planCardsForPeriod(rows, period);
  const selectable = cards.filter((card) => !card.locked);
  const selected = selectable.find((card) => card.tier === chosenTier) ?? selectable[0] ?? null;

  return (
    <AppScreen contentStyle={styles.content}>
      <Text style={styles.title}>Become a member</Text>

      {plans.isPending && (
        <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel="Loading membership plans">
          <Skeleton height={44} borderRadius={radius.pill} />
          <Skeleton height={320} borderRadius={radius.lg} />
          <Skeleton height={80} borderRadius={radius.lg} />
        </View>
      )}

      {plans.isError && (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load the membership plans.</Text>
          <PrimaryButton label="Try again" variant="ghost" onPress={() => void plans.refetch()} />
        </View>
      )}

      {plans.isSuccess && rows.length === 0 && (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.emptyTitle}>Memberships are not available yet</Text>
          <Text style={styles.emptyBody}>
            The club has not published its plans. Please check back soon.
          </Text>
          <PrimaryButton label="Try again" variant="ghost" onPress={() => void plans.refetch()} />
        </View>
      )}

      {plans.isSuccess && rows.length > 0 && (
        <>
          {periods.length > 1 && (
            <SegmentedControl
              label="Billing period"
              options={periods.map((value) => ({ value, label: PERIOD_LABELS[value] }))}
              value={period}
              onChange={setChosenPeriod}
            />
          )}

          <View style={styles.cards}>
            {cards.map((card) =>
              card.locked ? (
                <LockedPlanCard key={card.tier} card={card} />
              ) : (
                <SelectablePlanCard
                  key={card.tier}
                  card={card}
                  selected={selected?.tier === card.tier}
                  onSelect={() => setChosenTier(card.tier)}
                />
              ),
            )}
          </View>

          <View style={styles.footer}>
            {!emailVerified && (
              <Pressable
                accessibilityRole="link"
                onPress={() => router.replace('/onboarding/verify-email')}
              >
                <Text style={styles.footerLink}>Back to account details</Text>
              </Pressable>
            )}
            <PrimaryButton
              label="Continue"
              onPress={() => {
                if (selected) {
                  router.push({
                    pathname: '/onboarding/checkout',
                    params: { plan: selected.plan.id },
                  });
                }
              }}
            />
            <Pressable
              accessibilityRole="button"
              disabled={signOutMutation.isPending}
              onPress={() => signOutMutation.mutate()}
            >
              <Text style={styles.signOut}>Sign out</Text>
            </Pressable>
          </View>
        </>
      )}
    </AppScreen>
  );
}

function SelectablePlanCard({
  card,
  selected,
  onSelect,
}: {
  card: PlanCard;
  selected: boolean;
  onSelect: () => void;
}) {
  const { plan } = card;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${tierLabel(plan.tier)} membership, ${formatAmount(plan.amountCents)} ${periodSuffix(plan.interval)}`}
      onPress={onSelect}
      style={[styles.card, selected ? styles.cardSelected : null]}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardName}>{tierLabel(plan.tier)}</Text>
        {selected && (
          <View style={styles.checkCircle}>
            <Ionicons name="checkmark" size={16} color={colors.textOnAccent} />
          </View>
        )}
      </View>
      <View style={styles.priceRow}>
        <Text style={styles.price}>{formatAmount(plan.amountCents)}</Text>
        <Text style={styles.priceSuffix}> {periodSuffix(plan.interval)}</Text>
      </View>
      <Text style={styles.priceCaption}>{billingCaption(plan)}</Text>
      {plan.features.length > 0 && (
        <View style={styles.features}>
          {plan.features.map((feature) => (
            <View key={feature} style={styles.feature}>
              <Ionicons name="checkmark" size={16} color={colors.accent} style={styles.featureIcon} />
              <Text style={styles.featureText}>{feature}</Text>
            </View>
          ))}
        </View>
      )}
    </Pressable>
  );
}

/** Invite-only tier (Figma: the "Pro" card): visible but not selectable. */
function LockedPlanCard({ card }: { card: PlanCard }) {
  const { plan } = card;
  return (
    <View style={styles.lockedCard} accessibilityLabel={`${tierLabel(plan.tier)} membership, invite only`}>
      <View style={styles.cardHeader}>
        <Text style={styles.lockedName}>{tierLabel(plan.tier)}</Text>
        <Badge label="Invite only" variant="neutral" />
      </View>
      {plan.features.length > 0 && (
        <Text style={styles.lockedSummary}>{plan.features.join(' · ')}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
  },
  title: {
    ...typography.display,
    color: colors.text,
    marginTop: spacing.sm,
  },
  loading: {
    gap: spacing.md,
  },
  errorBox: {
    gap: spacing.sm,
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
  emptyTitle: {
    ...typography.h3,
    color: colors.text,
  },
  emptyBody: {
    ...typography.body,
    color: colors.textMuted,
  },
  cards: {
    gap: spacing.md,
  },
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceOverlay,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardSelected: {
    borderColor: colors.borderActive,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardName: {
    ...typography.h2,
    color: colors.text,
  },
  checkCircle: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: spacing.xs,
  },
  price: {
    fontFamily: fonts.displayHeavy,
    fontSize: 44,
    lineHeight: 50,
    color: colors.accent,
  },
  priceSuffix: {
    ...typography.body,
    color: colors.textMuted,
  },
  priceCaption: {
    ...typography.caption,
    color: colors.textSubtle,
  },
  features: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  feature: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  featureIcon: {
    marginTop: 1,
  },
  featureText: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
  lockedCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundDeep,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  lockedName: {
    ...typography.h2,
    color: colors.textMuted,
  },
  lockedSummary: {
    ...typography.body,
    color: colors.textSubtle,
  },
  footer: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  footerLink: {
    ...typography.bodyStrong,
    color: colors.accent,
    textAlign: 'center',
  },
  signOut: {
    ...typography.body,
    color: colors.textSubtle,
    textAlign: 'center',
  },
});
