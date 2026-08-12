import { Link, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { resetPasswordSchema, useZodForm, type ResetPasswordForm } from '../../lib/forms';
import { Button, ButtonLink, FormField, PasswordInput } from '../../components';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

/** Landing for the emailed reset link: /reset-password?token=... */
export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const form = useZodForm(resetPasswordSchema, {
    defaultValues: { password: '', confirmPassword: '' },
  });

  const reset = useMutation({
    mutationFn: (values: ResetPasswordForm) =>
      api.resetPassword({ token: token!, password: values.password }),
    onError: (error) => {
      form.setError('root', {
        message:
          error instanceof ApiError && error.status === 401
            ? 'This reset link is invalid or has expired. Request a new one.'
            : 'Could not reset your password. Please try again.',
      });
    },
  });

  if (!token) {
    return (
      <AuthLayout title="Link expired">
        <p className={styles.statusBody}>
          This password reset link is incomplete. Request a new one and try again.
        </p>
        <ButtonLink to="/forgot-password" variant="secondary" fullWidth>
          Request a new link
        </ButtonLink>
      </AuthLayout>
    );
  }

  if (reset.isSuccess) {
    return (
      <AuthLayout title="Password updated">
        <p className={styles.statusBody}>Your password has been changed. Sign in to continue.</p>
        <ButtonLink to="/sign-in" fullWidth>
          Sign in
        </ButtonLink>
      </AuthLayout>
    );
  }

  const rootError = form.formState.errors.root?.message;

  return (
    <AuthLayout
      title="Choose a new password"
      footer={
        <p className={styles.footerText}>
          <Link to="/sign-in">Back to sign in</Link>
        </p>
      }
    >
      <form
        className={styles.form}
        noValidate
        onSubmit={form.handleSubmit((values) => reset.mutate(values))}
      >
        {rootError && (
          <p role="alert" className={styles.alert}>
            {rootError}
          </p>
        )}
        <FormField
          label="New password"
          error={form.formState.errors.password?.message}
          hint="At least 8 characters"
        >
          {(field) => (
            <PasswordInput
              {...field}
              {...form.register('password')}
              autoComplete="new-password"
              placeholder="Enter new password"
            />
          )}
        </FormField>
        <FormField
          label="Confirm password"
          error={form.formState.errors.confirmPassword?.message}
        >
          {(field) => (
            <PasswordInput
              {...field}
              {...form.register('confirmPassword')}
              autoComplete="new-password"
              placeholder="Repeat new password"
            />
          )}
        </FormField>
        <div className={styles.formActions}>
          <Button type="submit" fullWidth loading={reset.isPending}>
            Update password
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
