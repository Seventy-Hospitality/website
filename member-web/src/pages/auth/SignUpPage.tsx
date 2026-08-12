import { Link, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { signUpSchema, useZodForm, type SignUpForm } from '../../lib/forms';
import { useSession } from '../../lib/session-context';
import { Button, FormField, Input, PasswordInput } from '../../components';
import { AuthLayout, OrDivider } from './AuthLayout';
import { OAuthButtons } from './OAuthButtons';
import styles from './auth.module.css';

/** Figma onboarding/create-account: OAuth, then name/email/password/phone. */
export function SignUpPage() {
  const navigate = useNavigate();
  const { refreshSession } = useSession();

  const form = useZodForm(signUpSchema, {
    defaultValues: { name: '', email: '', password: '', phone: '' },
  });

  const signUp = useMutation({
    mutationFn: (values: SignUpForm) =>
      api.signUp({
        name: values.name,
        email: values.email,
        password: values.password,
        phone: values.phone ? values.phone : undefined,
      }),
    onSuccess: async () => {
      await refreshSession();
      // New accounts land on the verification prompt; W1 takes over from
      // there with membership onboarding.
      navigate('/verify-email', { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'EMAIL_IN_USE') {
        form.setError('email', { message: 'An account with this email already exists' });
      } else {
        form.setError('root', {
          message: error instanceof ApiError ? error.message : 'Sign up failed. Please try again.',
        });
      }
    },
  });

  const rootError = form.formState.errors.root?.message;

  return (
    <AuthLayout
      title="Create account"
      footer={
        <>
          <p className={styles.footerText}>
            <Link to="/sign-in">Or login as member</Link>
          </p>
        </>
      }
    >
      <OAuthButtons intent="signup" />
      <OrDivider />
      <form
        className={styles.form}
        noValidate
        onSubmit={form.handleSubmit((values) => signUp.mutate(values))}
      >
        {rootError && (
          <p role="alert" className={styles.alert}>
            {rootError}
          </p>
        )}
        <FormField label="Full name" error={form.formState.errors.name?.message}>
          {(field) => (
            <Input
              {...field}
              {...form.register('name')}
              autoComplete="name"
              placeholder="First Last"
            />
          )}
        </FormField>
        <FormField label="Email" error={form.formState.errors.email?.message}>
          {(field) => (
            <Input
              {...field}
              {...form.register('email')}
              type="email"
              autoComplete="email"
              placeholder="Enter email"
            />
          )}
        </FormField>
        <FormField
          label="Password"
          error={form.formState.errors.password?.message}
          hint="At least 8 characters"
        >
          {(field) => (
            <PasswordInput
              {...field}
              {...form.register('password')}
              autoComplete="new-password"
              placeholder="Enter password"
            />
          )}
        </FormField>
        <FormField label="Phone" error={form.formState.errors.phone?.message}>
          {(field) => (
            <Input
              {...field}
              {...form.register('phone')}
              type="tel"
              autoComplete="tel"
              placeholder="+1 (XXX) XXX - XXXX"
            />
          )}
        </FormField>
        <div className={styles.formActions}>
          <Button type="submit" fullWidth loading={signUp.isPending}>
            Continue
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
