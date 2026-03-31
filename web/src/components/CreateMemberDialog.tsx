import { useState } from 'react';
import { Modal, ModalActions, Button, Input } from 'octahedron';
import { api, ApiError } from '../lib/api';
import { FormField } from './FormField';

interface Props {
  onCreated: (memberId: string) => void;
  onClose: () => void;
}

export function CreateMemberDialog({ onCreated, onClose }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });

  function update(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit() {
    if (!form.firstName.trim() || !form.lastName.trim() || !form.email.trim()) {
      setError('First name, last name, and email are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = await api.createMember({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
      });
      onCreated(data.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create member');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Member"
      width={420}
      error={error}
      footer={
        <ModalActions>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button color="primary" onClick={handleSubmit} loading={saving}>
            Create Member
          </Button>
        </ModalActions>
      }
    >
      <div style={{ padding: 'var(--octa-space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--octa-space-3)' }}>
        <div style={{ display: 'flex', gap: 'var(--octa-space-3)' }}>
          <FormField label="First Name">
            {(id) => <Input id={id} value={form.firstName} onValueChange={(v) => update('firstName', v)} />}
          </FormField>
          <FormField label="Last Name">
            {(id) => <Input id={id} value={form.lastName} onValueChange={(v) => update('lastName', v)} />}
          </FormField>
        </div>
        <FormField label="Email">
          {(id) => <Input id={id} type="email" value={form.email} onValueChange={(v) => update('email', v)} />}
        </FormField>
        <FormField label="Phone (optional)">
          {(id) => <Input id={id} type="tel" value={form.phone} onValueChange={(v) => update('phone', v)} />}
        </FormField>
      </div>
    </Modal>
  );
}
