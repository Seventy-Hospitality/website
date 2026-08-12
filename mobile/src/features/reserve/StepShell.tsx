import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, spacing } from '../../theme/tokens';

interface StepShellProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Pinned action(s) at the bottom (usually the Continue / pay button). */
  footer?: ReactNode;
}

/**
 * One wizard step's layout: a title + optional subtitle, a scrollable body,
 * and a pinned footer for the primary action. Keeps the three steps
 * consistent.
 */
export function StepShell({ title, subtitle, children, footer }: StepShellProps) {
  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text
          accessibilityRole="header"
          style={styles.title}
        >
          {title}
        </Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        {children}
      </ScrollView>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 24,
  },
  subtitle: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
    marginTop: -spacing.xs,
  },
  footer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
});
