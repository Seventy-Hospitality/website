/**
 * Shared frame for the account sub-screens (billing, preferences,
 * payment-method, change-membership, delete, sign-in-methods): the Figma
 * "‹ Back to …" link over a large page title, inside the standard AppScreen.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AppScreen } from '../../components';
import { colors, fonts, spacing, typography } from '../../theme/tokens';

interface AccountFrameProps {
  title: string;
  /** Text of the back link, e.g. "Back to account". */
  backLabel: string;
  /** Fallback route when there is no navigation history to pop. */
  backTo: string;
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function AccountFrame({
  title,
  backLabel,
  backTo,
  children,
  refreshing,
  onRefresh,
}: AccountFrameProps) {
  const router = useRouter();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(backTo as never);
  };

  return (
    <AppScreen contentStyle={styles.content} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        onPress={goBack}
        hitSlop={8}
        style={styles.backLink}
      >
        <Ionicons name="chevron-back" size={18} color={colors.textLink} />
        <Text style={styles.backLinkText}>{backLabel}</Text>
      </Pressable>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {children}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
  },
  backLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginLeft: -4,
  },
  backLinkText: {
    color: colors.textLink,
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  },
  title: {
    ...typography.display,
    color: colors.text,
    marginTop: -spacing.xs,
  },
});
