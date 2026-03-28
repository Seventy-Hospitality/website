import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input, ControlButton } from 'octahedron';
import { api } from '../lib/api';
import { FormField } from './FormField';
import styles from './CreateMemberForm.module.css';

export function CreateMemberForm() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });

  function update(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');

    try {
      const data = await api.createMember({
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone || undefined,
      });

      navigate(`/members/${data.id}`);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create member');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.container}>
      <button className={styles.back} onClick={() => navigate('/members')}>
        ← Members
      </button>
      <h1 className={styles.title}>Add Member</h1>

      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.row}>
          <FormField label="First Name">
            {(id) => (
              <Input
                id={id}
                value={form.firstName}
                onValueChange={(v) => update('firstName', v)}
                required
              />
            )}
          </FormField>
          <FormField label="Last Name">
            {(id) => (
              <Input
                id={id}
                value={form.lastName}
                onValueChange={(v) => update('lastName', v)}
                required
              />
            )}
          </FormField>
        </div>

        <FormField label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              value={form.email}
              onValueChange={(v) => update('email', v)}
              required
            />
          )}
        </FormField>

        <FormField label="Phone (optional)">
          {(id) => (
            <Input
              id={id}
              type="tel"
              value={form.phone}
              onValueChange={(v) => update('phone', v)}
            />
          )}
        </FormField>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <ControlButton type="button" onClick={() => navigate('/members')}>
            Cancel
          </ControlButton>
          <ControlButton type="submit" color="primary" loading={saving}>
            Create Member
          </ControlButton>
        </div>
      </form>
    </div>
  );
}
