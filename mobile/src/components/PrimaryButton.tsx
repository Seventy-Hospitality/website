import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius, spacing } from '../theme/tokens';

interface PrimaryButtonProps {
  label: string;
  onPress?: () => void;
  loading?: boolean;
  /** Muted, non-interactive gate (e.g. "Confirm" until terms are accepted). */
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}

export function PrimaryButton({
  label,
  loading = false,
  disabled = false,
  onPress,
  variant = 'primary',
}: PrimaryButtonProps) {
  // Loading shows a spinner and blocks presses; disabled is the Figma's muted
  // affordance (dimmed, non-interactive) while some gate is unmet.
  const inactive = disabled && !loading;
  const blocked = loading || disabled;
  return (
    <Pressable
      onPress={onPress}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityState={{ disabled: blocked, busy: loading }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' ? styles.primary : null,
        variant === 'secondary' ? styles.secondary : null,
        variant === 'ghost' ? styles.ghost : null,
        variant === 'danger' ? styles.danger : null,
        inactive ? styles.inactive : null,
        pressed && !blocked ? styles.pressed : null,
      ]}
    >
      <View style={styles.inner}>
        {loading ? (
          <ActivityIndicator
            color={variant === 'primary' || variant === 'danger' ? colors.backgroundDeep : colors.text}
          />
        ) : (
          <Text
            style={[
              styles.label,
              variant === 'primary' ? styles.primaryLabel : null,
              variant === 'danger' ? styles.dangerLabel : null,
            ]}
          >
            {label}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 46,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderWidth: 1,
  },
  inner: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  secondary: {
    backgroundColor: colors.sand,
    borderColor: colors.sand,
  },
  ghost: {
    backgroundColor: 'transparent',
    borderColor: colors.border,
  },
  danger: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
  },
  pressed: {
    opacity: 0.9,
  },
  inactive: {
    opacity: 0.45,
  },
  label: {
    color: colors.text,
    fontFamily: fonts.bodyBold,
    fontSize: 15,
  },
  primaryLabel: {
    color: colors.textOnAccent,
  },
  dangerLabel: {
    color: colors.backgroundDeep,
  },
});
