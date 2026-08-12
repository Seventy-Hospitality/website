/**
 * Tokens-only, accessible checkbox. Hoisted from the M1 onboarding checkout
 * (the terms gate) into the shared component set now that more than one flow
 * needs a checkbox.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius, spacing } from '../theme/tokens';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible label; also rendered as the tappable caption. */
  label: ReactNode;
  /** Announced label when `label` is a rich node rather than a string. */
  accessibilityLabel: string;
  disabled?: boolean;
}

export function Checkbox({
  checked,
  onChange,
  label,
  accessibilityLabel,
  disabled = false,
}: CheckboxProps) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      hitSlop={8}
      style={styles.row}
    >
      <View style={[styles.box, checked ? styles.boxChecked : null]}>
        {checked ? <Ionicons name="checkmark" size={16} color={colors.textOnAccent} /> : null}
      </View>
      {typeof label === 'string' ? <Text style={styles.label}>{label}</Text> : label}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  box: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderActive,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgElevated,
  },
  boxChecked: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  label: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
});
