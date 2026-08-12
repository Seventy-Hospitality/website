import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PrimaryButton } from '../../components';
import { colors, fonts, spacing } from '../../theme/tokens';

/**
 * Booking requires an active membership (the backend's active-member
 * policy). The onboarding gate guarantees one was purchased, so landing
 * here means it LAPSED; explain that instead of surfacing raw 403s.
 */
export function MembershipInactiveState() {
  const router = useRouter();
  return (
    <View style={styles.container}>
      <View style={styles.glyph}>
        <Ionicons name="card-outline" size={24} color={colors.accent} />
      </View>
      <Text style={styles.title}>Your membership is not active</Text>
      <Text style={styles.description}>
        Booking needs an active membership. Check your billing details to get back on court.
      </Text>
      <View style={styles.action}>
        <PrimaryButton label="Go to account" onPress={() => router.replace('/(tabs)/account')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  glyph: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceOverlay,
    marginBottom: spacing.xs,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 17,
    textAlign: 'center',
  },
  description: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 260,
    lineHeight: 18,
  },
  action: {
    marginTop: spacing.sm,
    alignSelf: 'stretch',
    paddingHorizontal: spacing.xl,
  },
});
