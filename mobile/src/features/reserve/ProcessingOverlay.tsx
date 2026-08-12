import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, spacing } from '../../theme/tokens';

interface ProcessingOverlayProps {
  visible: boolean;
  /** The assigned court, when known ("We're securing your spot on Court 2"). */
  resourceName?: string;
  noun: string;
  title?: string;
  body?: string;
}

/**
 * Full-screen "securing your spot" takeover (Figma loading-state 7:2845):
 * shown while the payment confirms and the hold flips to a confirmed
 * booking. A modal that swallows the hardware back button, so nothing can
 * reach the wizard chrome and cancel a hold whose payment just went
 * through while it settles.
 */
export function ProcessingOverlay({
  visible,
  resourceName,
  noun,
  title,
  body,
}: ProcessingOverlayProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      // Swallow Android back: there is nothing safe to return to mid-settle.
      onRequestClose={() => undefined}
    >
      <View style={styles.root} accessibilityRole="progressbar" accessibilityLabel={title ?? 'Securing your spot'}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.title}>{title ?? 'Securing your spot'}</Text>
        <Text style={styles.body}>
          {body ??
            (resourceName ? `We're securing your spot on ${resourceName}` : `We're securing your ${noun}`)}
        </Text>
        <Text style={styles.note}>Please keep this screen open</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    backgroundColor: 'rgba(12, 18, 13, 0.92)',
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 20,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  body: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
  note: {
    color: colors.textSubtle,
    fontFamily: fonts.body,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
});
