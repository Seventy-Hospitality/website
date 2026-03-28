import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog, Banner, Select, type SelectOption } from 'octahedron';
import { api, ApiError } from '../lib/api';
import { FormField } from './FormField';

interface Props {
  type: 'court' | 'shower';
  facilityId: string;
  facilityName: string;
  date: string;
  startTime: string;
  endTime: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function BookingConfirmDialog({
  type,
  facilityId,
  facilityName,
  date,
  startTime,
  endTime,
  onConfirm,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberId, setMemberId] = useState('');
  const [memberOptions, setMemberOptions] = useState<SelectOption[]>([]);

  useEffect(() => {
    api.listMembers({ limit: 250 }).then((result: any) => {
      const members = result?.data ?? result ?? [];
      setMemberOptions(
        members.map((m: any) => ({
          value: m.id,
          label: `${m.firstName} ${m.lastName}`,
        })),
      );
    });
  }, []);

  async function handleConfirm() {
    if (!memberId) {
      setError('Select a member');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (type === 'court') {
        await api.bookCourt(facilityId, date, startTime, memberId);
      } else {
        await api.bookShower(facilityId, date, startTime, memberId);
      }
      onConfirm();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <ConfirmDialog
      open
      title="Create Booking"
      onConfirm={handleConfirm}
      onClose={onClose}
      confirmText="Book"
      cancelText="Cancel"
      loading={loading}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gs-space-3)' }}>
        <div style={{ fontSize: 'var(--gs-font-size-body)', color: 'var(--gs-text)' }}>
          <strong>{facilityName}</strong> &middot; {date} &middot; {startTime}–{endTime}
        </div>

        <FormField label="Member">
          {(id) => (
            <Select
              options={memberOptions}
              value={memberId}
              onValueChange={(v) => setMemberId(v ?? '')}
              searchable
              searchPlaceholder="Search members..."
              noResultsMessage="No members found"
            />
          )}
        </FormField>

        {error && <Banner intent="danger">{error}</Banner>}
      </div>
    </ConfirmDialog>
  );
}
