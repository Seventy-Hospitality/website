import { useState } from 'react';
import { Input, ControlButton, TextLink } from 'octahedron';
import { FormField } from '../components/FormField';
import { SeventyLogo } from '../components/SeventyLogo';
import { api } from '../lib/api';
import styles from './SignInPage.module.css';

export function SignInPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await api.sendMagicLink(email);
      setSent(true);
    } catch {
      setError('Failed to send login link. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className={styles.container}>
        <div className={styles.card}>
          <h1 className={styles.title}>Check your email</h1>
          <p className={styles.text}>
            We sent a sign-in link to <strong>{email}</strong>.
          </p>
          <TextLink onClick={() => setSent(false)}>Use a different email</TextLink>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.logoWrap}>
          <SeventyLogo size={48} />
        </div>
        <h1 className={styles.title}>Seventy</h1>
        <p className={styles.text}>Sign in with your email address</p>
        <form onSubmit={handleSubmit} className={styles.form}>
          <FormField label="Email">
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                onValueChange={setEmail}
                placeholder="admin@seventy.club"
                autoFocus
              />
            )}
          </FormField>
          <ControlButton type="submit" color="accent" loading={loading}>
            Send sign-in link
          </ControlButton>
          {error && <p className={styles.error}>{error}</p>}
        </form>
      </div>
    </div>
  );
}
