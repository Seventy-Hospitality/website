import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { signInSchema, useZodForm, type SignInForm } from '../../lib/forms';
import { redirectAfterAuth, useSession } from '../../lib/session-context';
import { Button, FormField, Input, PasswordInput } from '../../components';
import { AuthLayout, OrDivider } from './AuthLayout';
import { OAuthButtons } from './OAuthButtons';
import styles from './auth.module.css';

/** Backend magic-link failures land here as /sign-in?error=... */
const LINK_ERRORS: Record<string, string> = {
  invalid_token: 'That sign-in link is invalid or has expired. Request a new one below.',
  missing_token: 'That sign-in link was incomplete. Request a new one below.',
  unknown: 'Something went wrong completing your sign-in. Please try again.',
};

/** Figma onboarding "Sign In" frame: OAuth, then email/password. */
export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { refreshSession } = useSession();

  const linkError = searchParams.get('error');
  const linkErrorMessage = linkError ? (LINK_ERRORS[linkError] ?? LINK_ERRORS.unknown) : null;

  const form = useZodForm(signInSchema, {
    defaultValues: { email: '', password: '' },
  });

  const signIn = useMutation({
    mutationFn: (values: SignInForm) => api.signIn(values),
    onSuccess: async () => {
      await refreshSession();
      navigate(redirectAfterAuth(location), { replace: true });
    },
    onError: (error) => {
      form.setError('root', {
        message:
          error instanceof ApiError && error.status === 401
            ? 'Incorrect email or password'
            : 'Sign in failed. Please try again.',
      });
    },
  });

  const rootError = form.formState.errors.root?.message;

  return (
    <AuthLayout
      title="Sign In"
      footer={
        <p className={styles.footerText}>
          <Link to="/sign-up">Or create an account</Link>
        </p>
      }
    >
      <OAuthButtons intent="signin" />
      <OrDivider />
      <form
        className={styles.form}
        noValidate
        onSubmit={form.handleSubmit((values) => signIn.mutate(values))}
      >
        {(rootError ?? linkErrorMessage) && (
          <p role="alert" className={styles.alert}>
            {rootError ?? linkErrorMessage}
          </p>
        )}
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
        <FormField label="Password" error={form.formState.errors.password?.message}>
          {(field) => (
            <PasswordInput
              {...field}
              {...form.register('password')}
              autoComplete="current-password"
              placeholder="Enter password"
            />
          )}
        </FormField>
        <div className={styles.inlineLinkRow}>
          <Link to="/forgot-password">Forgot password?</Link>
          <Link to="/magic-link">Email me a sign-in link</Link>
        </div>
        <div className={styles.formActions}>
          <Button type="submit" fullWidth loading={signIn.isPending}>
            Sign in
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
