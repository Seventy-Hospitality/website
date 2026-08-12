/**
 * Grouped settings rows for the account surface (M6), matching the Figma
 * account / preferences / billing cards: an optional uppercase section label
 * over a single card whose rows are separated by hairline dividers. Each row is
 * an icon + label with a trailing chevron (navigation), value (e.g. version),
 * switch (a toggle passed as `trailing`), or an inert "Coming soon" chip.
 */
import { Children, Fragment, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Badge } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';

interface SettingsGroupProps {
  label?: string;
  children: ReactNode;
}

/** A titled card of rows with dividers between them. */
export function SettingsGroup({ label, children }: SettingsGroupProps) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.group}>
      {label ? <Text style={styles.groupLabel}>{label}</Text> : null}
      <View style={styles.card}>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <View style={styles.divider} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

interface SettingsRowProps {
  icon?: keyof typeof Ionicons.glyphMap;
  label: string;
  /** Right-aligned muted value (e.g. the app version). */
  value?: string;
  /** Trailing control, e.g. a Switch. Suppresses the chevron. */
  trailing?: ReactNode;
  onPress?: () => void;
  /** Lime label + icon (sign out, delete, change membership). */
  accent?: boolean;
  /** Danger label + icon. */
  destructive?: boolean;
  disabled?: boolean;
  /** Inert row with a "Coming soon" chip (no navigation). */
  comingSoon?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
}

export function SettingsRow({
  icon,
  label,
  value,
  trailing,
  onPress,
  accent = false,
  destructive = false,
  disabled = false,
  comingSoon = false,
  loading = false,
  accessibilityLabel,
}: SettingsRowProps) {
  const inert = disabled || comingSoon || loading || !onPress;
  const iconColor = destructive ? colors.danger : accent ? colors.accent : colors.textMuted;
  const labelColor = destructive ? colors.danger : accent ? colors.accent : colors.text;
  const showChevron = Boolean(onPress) && !trailing && !value && !comingSoon;

  const body = (
    <>
      {icon ? <Ionicons name={icon} size={20} color={iconColor} style={styles.icon} /> : null}
      <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.trailing}>
        {loading ? <ActivityIndicator color={colors.textMuted} /> : null}
        {value ? <Text style={styles.value}>{value}</Text> : null}
        {comingSoon ? <Badge label="Coming soon" variant="neutral" /> : null}
        {trailing}
        {showChevron ? (
          <Ionicons name="chevron-forward" size={18} color={colors.textSubtle} />
        ) : null}
      </View>
    </>
  );

  if (inert) {
    return (
      <View
        style={[styles.row, disabled || comingSoon ? styles.rowMuted : null]}
        accessibilityRole={comingSoon ? 'text' : undefined}
        accessibilityLabel={accessibilityLabel}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: {
    gap: spacing.sm,
  },
  groupLabel: {
    ...typographyLabel(),
  },
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 54,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  rowPressed: {
    backgroundColor: colors.surfaceOverlay,
  },
  rowMuted: {
    opacity: 0.6,
  },
  icon: {
    width: 22,
    textAlign: 'center',
  },
  label: {
    flex: 1,
    fontFamily: fonts.bodyMedium,
    fontSize: 15,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  value: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 15,
  },
});

// Inline to avoid re-importing typography just for one preset.
function typographyLabel() {
  return {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
    marginLeft: spacing.xs,
  };
}
