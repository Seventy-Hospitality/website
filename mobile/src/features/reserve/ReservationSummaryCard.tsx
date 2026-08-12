import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { ResourceTypeTile } from './ResourceTypeIcon';

export interface ReservationSummaryRow {
  label: string;
  value: string;
}

export interface ReservationSummaryCardProps {
  typeCode: string;
  typeName: string;
  /** The server-assigned court/resource ("Court 2"), revealed at checkout. */
  resourceName?: string;
  rows: ReservationSummaryRow[];
  /**
   * Full-width line above the amenity head (M2 home's "AI suggestion" and
   * "SARAH invited you" lines; mirrors member-web's ReservationCard header).
   */
  header?: ReactNode;
  /** Trailing badge in the header (e.g. a status badge for M4). */
  trailing?: ReactNode;
  /** Custom body under the header (M4 edit's old -> new change rows). */
  children?: ReactNode;
}

/**
 * The reservation detail card (Figma checkout 14:582 + confirmation 7:2772):
 * amenity glyph, type name, the assigned court, then stacked label/value
 * rows. Exposed for M4 (reservation detail) and M2 (home) to reuse the same
 * card shape.
 */
export function ReservationSummaryCard({
  typeCode,
  typeName,
  resourceName,
  rows,
  header,
  trailing,
  children,
}: ReservationSummaryCardProps) {
  return (
    <View style={styles.card}>
      {header}
      <View style={styles.head}>
        <ResourceTypeTile code={typeCode} />
        <View style={styles.headText}>
          <Text style={styles.typeName} numberOfLines={1}>
            {typeName}
          </Text>
          {resourceName ? (
            <Text style={styles.resourceName} numberOfLines={1}>
              {resourceName}
            </Text>
          ) : null}
        </View>
        {trailing ? <View style={styles.headTrailing}>{trailing}</View> : null}
      </View>

      {rows.length > 0 ? (
        <View style={styles.rows}>
          {rows.map((row, index) => (
            <View
              key={row.label}
              style={[styles.row, index === 0 ? styles.rowFirst : null]}
            >
              <Text style={styles.label}>{row.label}</Text>
              <Text style={styles.value} numberOfLines={1}>
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headText: {
    flex: 1,
    gap: 2,
  },
  headTrailing: {
    marginLeft: 'auto',
  },
  typeName: {
    color: colors.text,
    fontFamily: fonts.displaySemibold,
    fontSize: 17,
  },
  resourceName: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  rows: {
    flexDirection: 'column',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowFirst: {
    borderTopWidth: 0,
    paddingTop: 0,
  },
  label: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  value: {
    flexShrink: 1,
    textAlign: 'right',
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
  },
});
