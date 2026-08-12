import { useState } from 'react';
import { Link, Redirect } from 'expo-router';
import { Controller } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../lib/session';
import { ApiError } from '../../lib/api';
import { signInSchema, emailOnlySchema, useZodForm } from '../../lib/forms';
import { AppScreen } from '../../components/AppScreen';
import { PrimaryButton } from '../../components/PrimaryButton';
import { SectionCard } from '../../components/SectionCard';
import { FormField, Input, PasswordInput } from '../../components/FormField';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/toast-context';
import { OAuthButtons } from './OAuthButtons';
import { colors, spacing, typography } from '../../theme/tokens';

type Mode = 'password' | 'magic';

export function SignInScreen() {
  const { status, signInWithPassword, requestMagicLink } = useSession();
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>('password');
  const [magicSent, setMagicSent] = useState<string | null>(null);

  const passwordForm = useZodForm(signInSchema, { defaultValues: { email: '', password: '' } });
  const magicForm = useZodForm(emailOnlySchema, { defaultValues: { email: '' } });

  if (status === 'authenticated') {
    return <Redirect href="/(tabs)" />;
  }

  const onPassword = passwordForm.handleSubmit(async (values) => {
    try {
      await signInWithPassword(values);
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 401
          ? 'Incorrect email or password.'
          : 'Unable to sign in right now.';
      passwordForm.setError('password', { message });
    }
  });

  const onMagic = magicForm.handleSubmit(async (values) => {
    try {
      await requestMagicLink(values.email);
      setMagicSent(values.email);
    } catch {
      toast({ variant: 'error', message: 'Unable to send the sign-in email right now.' });
    }
  });

  return (
    <AppScreen contentStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>Club70</Text>
        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>Sign in to reservations, clubs, and your membership.</Text>
      </View>

      <SectionCard>
        <SegmentedControl
          label="Sign-in method"
          value={mode}
          onChange={(next) => setMode(next)}
          options={[
            { value: 'password', label: 'Password' },
            { value: 'magic', label: 'Magic link' },
          ]}
        />

        {mode === 'password' ? (
          <View style={styles.form}>
            <Controller
              control={passwordForm.control}
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
            <Controller
              control={passwordForm.control}
              name="password"
              render={({ field: { onBlur, onChange, value }, fieldState }) => (
                <FormField label="Password" error={fieldState.error?.message}>
                  <PasswordInput
                    autoComplete="password"
                    placeholder="Your password"
                    hasError={Boolean(fieldState.error)}
                    onBlur={onBlur}
                    onChangeText={onChange}
                    value={value}
                  />
                </FormField>
              )}
            />
            <PrimaryButton
              label="Sign In"
              loading={passwordForm.formState.isSubmitting}
              onPress={() => void onPassword()}
            />
            <Link href="/auth/forgot-password" style={styles.link}>
              Forgot password?
            </Link>
          </View>
        ) : (
          <View style={styles.form}>
            <Controller
              control={magicForm.control}
              name="email"
              render={({ field: { onBlur, onChange, value }, fieldState }) => (
                <FormField
                  label="Email"
                  error={fieldState.error?.message}
                  hint="We email a one-tap link that opens this app."
                >
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
              label="Send Magic Link"
              loading={magicForm.formState.isSubmitting}
              onPress={() => void onMagic()}
            />
            {magicSent ? <Text style={styles.success}>Magic link sent to {magicSent}.</Text> : null}
          </View>
        )}
      </SectionCard>

      <View style={styles.dividerRow}>
        <View style={styles.divider} />
        <Text style={styles.dividerLabel}>or</Text>
        <View style={styles.divider} />
      </View>

      <OAuthButtons />

      <View style={styles.footer}>
        <Text style={styles.footerText}>New to Club70?</Text>
        <Link href="/auth/sign-up" style={styles.link}>
          Create an account
        </Link>
      </View>
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
  link: {
    color: colors.accent,
    ...typography.bodyStrong,
    textAlign: 'center',
  },
  success: {
    color: colors.accent,
    ...typography.caption,
    textAlign: 'center',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  divider: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerLabel: {
    color: colors.textSubtle,
    ...typography.caption,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
  },
  footerText: {
    color: colors.textMuted,
    ...typography.body,
  },
});
