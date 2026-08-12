import { Link, Redirect, useRouter } from 'expo-router';
import { Controller } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../lib/session';
import { ApiError } from '../../lib/api';
import { signUpSchema, useZodForm } from '../../lib/forms';
import { AppScreen } from '../../components/AppScreen';
import { PrimaryButton } from '../../components/PrimaryButton';
import { SectionCard } from '../../components/SectionCard';
import { FormField, Input, PasswordInput } from '../../components/FormField';
import { useToast } from '../../components/toast-context';
import { OAuthButtons } from './OAuthButtons';
import { colors, spacing, typography } from '../../theme/tokens';

export function SignUpScreen() {
  const router = useRouter();
  const { status, signUpWithPassword } = useSession();
  const { toast } = useToast();

  const form = useZodForm(signUpSchema, {
    defaultValues: { name: '', email: '', password: '', phone: '' },
  });

  if (status === 'authenticated') {
    return <Redirect href="/(tabs)" />;
  }

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await signUpWithPassword({
        name: values.name,
        email: values.email,
        password: values.password,
        phone: values.phone ? values.phone : undefined,
      });
      // The auth guard redirects; onboarding gating is the M1 package's job.
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_IN_USE') {
        form.setError('email', { message: 'That email already has an account.' });
        return;
      }
      toast({ variant: 'error', message: 'Unable to create your account right now.' });
    }
  });

  return (
    <AppScreen contentStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>Club70</Text>
        <Text style={styles.title}>Create your account</Text>
        <Text style={styles.subtitle}>A few details and you are in.</Text>
      </View>

      <SectionCard>
        <View style={styles.form}>
          <Controller
            control={form.control}
            name="name"
            render={({ field: { onBlur, onChange, value }, fieldState }) => (
              <FormField label="Full name" error={fieldState.error?.message}>
                <Input
                  autoComplete="name"
                  placeholder="Alex Morgan"
                  hasError={Boolean(fieldState.error)}
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={value}
                />
              </FormField>
            )}
          />
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
          <Controller
            control={form.control}
            name="phone"
            render={({ field: { onBlur, onChange, value }, fieldState }) => (
              <FormField label="Phone (optional)" error={fieldState.error?.message}>
                <Input
                  autoComplete="tel"
                  keyboardType="phone-pad"
                  placeholder="+1 555 123 4567"
                  hasError={Boolean(fieldState.error)}
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={value ?? ''}
                />
              </FormField>
            )}
          />
          <Controller
            control={form.control}
            name="password"
            render={({ field: { onBlur, onChange, value }, fieldState }) => (
              <FormField
                label="Password"
                error={fieldState.error?.message}
                hint="At least 8 characters."
              >
                <PasswordInput
                  autoComplete="new-password"
                  placeholder="Create a password"
                  hasError={Boolean(fieldState.error)}
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={value}
                />
              </FormField>
            )}
          />
          <PrimaryButton
            label="Create Account"
            loading={form.formState.isSubmitting}
            onPress={() => void onSubmit()}
          />
        </View>
      </SectionCard>

      <View style={styles.dividerRow}>
        <View style={styles.divider} />
        <Text style={styles.dividerLabel}>or</Text>
        <View style={styles.divider} />
      </View>

      <OAuthButtons />

      <View style={styles.footer}>
        <Text style={styles.footerText}>Already a member?</Text>
        <Link href="/auth/sign-in" style={styles.link} onPress={() => router.back()}>
          Sign in
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
