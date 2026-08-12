/**
 * One expandable billing-history month (Figma billing 107:10434). Collapsed it
 * shows the month + "N transactions · $total"; the first expand lazily fetches
 * that month's ledger rows (['billing','transactions',month]) and keeps them
 * afterwards. Mirrors member-web's MonthDisclosure.
 */
import { useId, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import type { BillingMonth, BillingTransaction } from '../../lib/api';
import { PrimaryButton, Skeleton } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { billingTransactionsQuery } from './account-data';
import {
  TXN_STATUS_LABELS,
  billingMonthLabel,
  billingMonthSummary,
  instantDateLabel,
  transactionAmountLabel,
} from './account-lib';

export function BillingMonthRow({ month, timezone }: { month: BillingMonth; timezone: string }) {
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);

  const transactions = useQuery({
    ...billingTransactionsQuery(month.month),
    enabled: everOpened,
  });

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${billingMonthLabel(month.month)}, ${billingMonthSummary(month.count, month.netCents)}`}
        onPress={() => {
          setOpen((prev) => !prev);
          setEverOpened(true);
        }}
        style={styles.header}
      >
        <View style={styles.headerText}>
          <Text style={styles.monthLabel}>{billingMonthLabel(month.month)}</Text>
          <Text style={styles.summary}>{billingMonthSummary(month.count, month.netCents)}</Text>
        </View>
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={colors.textSubtle}
        />
      </Pressable>

      {open ? (
        <View nativeID={regionId} style={styles.region}>
          {transactions.isPending ? (
            <View accessibilityLabel="Loading transactions" style={styles.regionLoading}>
              <Skeleton height={44} borderRadius={radius.sm} />
              <Skeleton height={44} borderRadius={radius.sm} />
            </View>
          ) : transactions.isError ? (
            <View style={styles.regionError} accessibilityRole="alert">
              <Text style={styles.emptyText}>We could not load this month.</Text>
              <PrimaryButton
                label="Try again"
                variant="secondary"
                onPress={() => void transactions.refetch()}
              />
            </View>
          ) : transactions.data.transactions.length === 0 ? (
            <Text style={styles.emptyText}>No transactions this month.</Text>
          ) : (
            <View style={styles.txnList}>
              {transactions.data.transactions.map((txn) => (
                <TransactionRow key={txn.id} txn={txn} timezone={timezone} />
              ))}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

function TransactionRow({ txn, timezone }: { txn: BillingTransaction; timezone: string }) {
  const statusLabel = TXN_STATUS_LABELS[txn.status];
  const inactive = txn.status === 'failed' || txn.status === 'canceled';
  const isCredit = txn.direction === 'credit' && !inactive;

  const meta = [instantDateLabel(txn.occurredAt, timezone), statusLabel].filter(Boolean).join(' · ');

  return (
    <View style={styles.txn}>
      <View style={styles.txnText}>
        <Text style={[styles.txnDescription, inactive ? styles.txnMuted : null]} numberOfLines={2}>
          {txn.description}
        </Text>
        <View style={styles.txnMetaRow}>
          <Text style={styles.txnMeta}>{meta}</Text>
          {txn.receiptUrl ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="View receipt"
              onPress={() => void Linking.openURL(txn.receiptUrl as string)}
              hitSlop={6}
            >
              <Text style={styles.receiptLink}> · Receipt</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <Text
        style={[
          styles.txnAmount,
          inactive ? styles.txnMuted : null,
          isCredit ? styles.txnCredit : null,
        ]}
      >
        {transactionAmountLabel(txn)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  monthLabel: {
    color: colors.text,
    fontFamily: fonts.displaySemibold,
    fontSize: 16,
  },
  summary: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  region: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  regionLoading: {
    gap: spacing.sm,
  },
  regionError: {
    gap: spacing.sm,
  },
  emptyText: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  txnList: {
    gap: spacing.md,
  },
  txn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  txnText: {
    flex: 1,
    gap: 2,
  },
  txnDescription: {
    color: colors.text,
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
  },
  txnMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  txnMeta: {
    color: colors.textSubtle,
    fontFamily: fonts.body,
    fontSize: 12,
  },
  receiptLink: {
    color: colors.accent,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
  },
  txnAmount: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  },
  txnMuted: {
    color: colors.textSubtle,
  },
  txnCredit: {
    color: colors.success,
  },
});
