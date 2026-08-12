/**
 * Shared full-screen states for the onboarding gate: the loading spinner
 * while the resume read is in flight, a retryable error, and the "no member
 * profile" support screen (a verified account with no linked member row,
 * which must never be redirected into a loop). Mirrors the web
 * OnboardingGate's GateError / NoProfileScreen.
 */
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PrimaryButton } from '../../../components/PrimaryButton';
import { colors, spacing, typography } from '../../../theme/tokens';

export function GateLoading({ label = 'Loading your membership' }: { label?: string }) {
  return (
    <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function GateError({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.center} accessibilityRole="alert">
      <Ionicons name="cloud-offline-outline" size={40} color={colors.textMuted} />
      <Text style={styles.title}>We could not load your membership</Text>
      <Text style={styles.muted}>Check your connection and try again.</Text>
      <View style={styles.action}>
        <PrimaryButton label="Try again" onPress={onRetry} />
      </View>
    </View>
  );
}

export function NoProfileScreen({
  onRefresh,
  onSignOut,
}: {
  onRefresh: () => Promise<unknown>;
  onSignOut: () => Promise<unknown>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function run(
    fn: () => Promise<unknown>,
    setBusy: (value: boolean) => void,
  ): Promise<void> {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.center} accessibilityRole="alert">
      <Ionicons name="person-remove-outline" size={40} color={colors.textMuted} />
      <Text style={styles.title}>We could not find your member profile</Text>
      <Text style={styles.muted}>
        Your account is not linked to a club member profile yet. Contact the club to get set up, or
        sign out and use a different account.
      </Text>
      <View style={styles.action}>
        <PrimaryButton
          label="Check again"
          loading={refreshing}
          onPress={() => void run(onRefresh, setRefreshing)}
        />
        <PrimaryButton
          label="Sign out"
          variant="ghost"
          loading={signingOut}
          onPress={() => void run(onSignOut, setSigningOut)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.bg,
  },
  title: {
    ...typography.h2,
    color: colors.text,
    textAlign: 'center',
  },
  muted: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  action: {
    alignSelf: 'stretch',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
});
