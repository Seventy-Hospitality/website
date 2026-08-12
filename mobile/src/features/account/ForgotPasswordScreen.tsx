import { useState } from 'react';
import { Link } from 'expo-router';
import { Controller } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../lib/session';
import { emailOnlySchema, useZodForm } from '../../lib/forms';
import { AppScreen } from '../../components/AppScreen';
import { PrimaryButton } from '../../components/PrimaryButton';
import { SectionCard } from '../../components/SectionCard';
import { FormField, Input } from '../../components/FormField';
import { colors, spacing, typography } from '../../theme/tokens';

export function ForgotPasswordScreen() {
  const { forgotPassword } = useSession();
  const [sent, setSent] = useState(false);
  const form = useZodForm(emailOnlySchema, { defaultValues: { email: '' } });

  // The backend always answers success (no email enumeration), so we show the
  // same confirmation whether or not the address exists.
  const onSubmit = form.handleSubmit(async (values) => {
    await forgotPassword(values.email).catch(() => undefined);
    setSent(true);
  });

  return (
    <AppScreen contentStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>Club70</Text>
        <Text style={styles.title}>Reset your password</Text>
        <Text style={styles.subtitle}>
          Enter your email and we will send a link to set a new password.
        </Text>
      </View>

      <SectionCard>
        {sent ? (
          <Text style={styles.success}>
            If an account exists for that email, a reset link is on its way. Follow it to set a new
            password.
          </Text>
        ) : (
          <View style={styles.form}>
            <Controller
              control={form.control}
              name="email"
              render={({ field: { onBlur, onChange, value }, fieldState }) => (
                <FormField label="Email" error={fieldState.error?.message}>
                  <Input
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    placeholder="you@club70.com"
                    hasError={Boolean(fieldState.error)}
                    onBlur={onBlur}
                    onChangeText={onChange}
                    value={value}
                  />
                </FormField>
              )}
            />
            <PrimaryButton
              label="Send Reset Link"
              loading={form.formState.isSubmitting}
              onPress={() => void onSubmit()}
            />
          </View>
        )}
      </SectionCard>

      <Link href="/auth/sign-in" style={styles.link}>
        Back to sign in
      </Link>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
  },
  hero: {
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  kicker: {
    color: colors.accent,
    ...typography.label,
    textTransform: 'uppercase',
  },
  title: {
    ...typography.display,
    color: colors.text,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
  },
  form: {
    gap: spacing.md,
  },
  success: {
    ...typography.body,
    color: colors.text,
  },
  link: {
    color: colors.accent,
    ...typography.bodyStrong,
    textAlign: 'center',
  },
});
