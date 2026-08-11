import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { emailOnlySchema, useZodForm, type EmailOnlyForm } from '../../lib/forms';
import { Button, FormField, Input } from '../../components';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

export function ForgotPasswordPage() {
  const form = useZodForm(emailOnlySchema, { defaultValues: { email: '' } });

  const send = useMutation({
    mutationFn: (values: EmailOnlyForm) => api.forgotPassword(values.email),
  });

  if (send.isSuccess) {
    return (
      <AuthLayout title="Check your email">
        <p className={styles.statusBody}>
          If an account exists for{' '}
          <span className={styles.statusEmail}>{form.getValues('email')}</span>, we sent a link
          to reset your password.
        </p>
        <Button variant="ghost" onClick={() => send.reset()}>
          Use a different email
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset password"
      footer={
        <p className={styles.footerText}>
          <Link to="/sign-in">Back to sign in</Link>
        </p>
      }
    >
      <p className={styles.statusBody}>
        Enter your email and we will send you a link to choose a new password.
      </p>
      <form
        className={styles.form}
        noValidate
        onSubmit={form.handleSubmit((values) => send.mutate(values))}
      >
        {send.isError && (
          <p role="alert" className={styles.alert}>
            Could not send the reset link. Please try again.
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
        <div className={styles.formActions}>
          <Button type="submit" fullWidth loading={send.isPending}>
            Send reset link
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
