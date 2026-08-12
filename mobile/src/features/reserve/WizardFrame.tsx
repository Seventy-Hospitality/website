import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '../../theme/tokens';

export type WizardStep = 1 | 2 | 3;

export const STEP_NAMES: Record<WizardStep, string> = {
  1: 'Choose a time',
  2: 'Invite players',
  3: 'Checkout',
};

interface WizardFrameProps {
  onBack: () => void;
  onClose: () => void;
  /** The active step; omitted on the frame-level states (loader/error/gate). */
  step?: WizardStep;
  /**
   * Disables Back/Close while a submitted payment may have captured: leaving
   * then would try to cancel a hold the member paid for. The hold ledger is
   * the real backstop (release() skips the cancel when locked), this is UX.
   */
  chromeDisabled?: boolean;
  children: ReactNode;
}

/**
 * The full-screen wizard chrome (Figma "Booking badminton court" 26:630):
 * a back arrow, a close button, and the 3-segment progress bar. Rendered
 * outside the tab shell so the booking flow takes over the screen.
 */
export function WizardFrame({
  onBack,
  onClose,
  step,
  chromeDisabled = false,
  children,
}: WizardFrameProps) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.chrome}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          accessibilityState={{ disabled: chromeDisabled }}
          disabled={chromeDisabled}
          onPress={onBack}
          hitSlop={8}
          style={({ pressed }) => [styles.chromeButton, pressed ? styles.chromePressed : null]}
        >
          <Ionicons
            name="arrow-back"
            size={22}
            color={chromeDisabled ? colors.textSubtle : colors.text}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close booking"
          accessibilityState={{ disabled: chromeDisabled }}
          disabled={chromeDisabled}
          onPress={onClose}
          hitSlop={8}
          style={({ pressed }) => [styles.chromeButton, pressed ? styles.chromePressed : null]}
        >
          <Ionicons
            name="close"
            size={24}
            color={chromeDisabled ? colors.textSubtle : colors.text}
          />
        </Pressable>
      </View>

      {step !== undefined ? (
        <View
          style={styles.progress}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 1, max: 3, now: step }}
          accessibilityLabel={`Step ${step} of 3: ${STEP_NAMES[step]}`}
        >
          {([1, 2, 3] as const).map((index) => (
            <View
              key={index}
              style={[
                styles.segment,
                index <= step ? styles.segmentActive : null,
              ]}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.body}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  chrome: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  chromeButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  chromePressed: {
    opacity: 0.6,
  },
  progress: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  segment: {
    flex: 1,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceOverlay,
  },
  segmentActive: {
    backgroundColor: colors.accent,
  },
  body: {
    flex: 1,
  },
});
