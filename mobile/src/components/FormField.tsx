import { forwardRef, useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius, spacing } from '../theme/tokens';

interface FormFieldProps {
  /** Rendered uppercase per the Figma ("EMAIL", "FULL NAME"). */
  label: string;
  /** Validation message; replaces the hint when present. */
  error?: string;
  /** Helper text shown when there is no error. */
  hint?: string;
  children: ReactNode;
}

/** Labelled field wrapper: label + control + error/hint text. */
export function FormField({ label, error, hint, children }: FormFieldProps) {
  const message = error ?? hint;
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {message ? (
        <Text style={error ? styles.error : styles.hint} accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
    </View>
  );
}

export interface InputProps extends TextInputProps {
  hasError?: boolean;
}

/**
 * Styled text input. react-hook-form friendly: spread a Controller field's
 * `onChangeText`/`onBlur`/`value` straight onto it.
 */
export const Input = forwardRef<TextInput, InputProps>(function Input({ hasError, style, ...rest }, ref) {
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.textSubtle}
      style={[styles.input, hasError ? styles.inputError : null, style]}
      {...rest}
    />
  );
});

export type PasswordInputProps = Omit<InputProps, 'secureTextEntry'>;

/** Password input with a show/hide toggle. */
export const PasswordInput = forwardRef<TextInput, PasswordInputProps>(function PasswordInput(
  { hasError, style, ...rest },
  ref,
) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.passwordWrap}>
      <TextInput
        ref={ref}
        secureTextEntry={!visible}
        autoCapitalize="none"
        placeholderTextColor={colors.textSubtle}
        style={[styles.input, styles.passwordInput, hasError ? styles.inputError : null, style]}
        {...rest}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={visible ? 'Hide password' : 'Show password'}
        onPress={() => setVisible((v) => !v)}
        hitSlop={8}
        style={styles.passwordToggle}
      >
        <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} />
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  label: {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  input: {
    minHeight: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 15,
    backgroundColor: colors.bgElevated,
  },
  inputError: {
    borderColor: colors.danger,
  },
  passwordWrap: {
    position: 'relative',
    justifyContent: 'center',
  },
  passwordInput: {
    paddingRight: 48,
  },
  passwordToggle: {
    position: 'absolute',
    right: spacing.md,
    height: '100%',
    justifyContent: 'center',
  },
  error: {
    color: colors.danger,
    fontFamily: fonts.body,
    fontSize: 12,
  },
  hint: {
    color: colors.textSubtle,
    fontFamily: fonts.body,
    fontSize: 12,
  },
});
