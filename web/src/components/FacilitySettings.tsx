import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  AppIcon,
  Callout,
  Tag,
  Text,
  Modal,
  ModalActions,
  Input,
  Toggle,
  DataTable,
  type DataTableColumn,
  TabButton,
} from 'octahedron';
import { api } from '../lib/api';
import { FormField } from './FormField';
import styles from './FacilitySettings.module.css';

interface Facility {
  id: string;
  name: string;
  slotDurationMinutes: number;
  operatingHoursStart: string;
  operatingHoursEnd: string;
  maxAdvanceDays: number;
  maxBookingsPerMemberPerDay: number;
  cancellationDeadlineMinutes: number;
  active: boolean;
}

type FacilityTab = 'courts' | 'showers';

const courtColumns: DataTableColumn<Facility>[] = [
  { name: 'Name', cell: (r) => r.name, sortValue: (r) => r.name },
  { name: 'Slot', cell: (r) => `${r.slotDurationMinutes} min`, maxWidth: 80 },
  { name: 'Hours', cell: (r) => `${r.operatingHoursStart}–${r.operatingHoursEnd}`, maxWidth: 120 },
  { name: 'Advance', cell: (r) => `${r.maxAdvanceDays}d`, maxWidth: 80 },
  { name: 'Max/Day', cell: (r) => String(r.maxBookingsPerMemberPerDay), maxWidth: 80 },
  { name: 'Cancel', cell: (r) => `${r.cancellationDeadlineMinutes} min`, maxWidth: 80 },
  {
    name: 'Status',
    cell: (r) => <Tag variant={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Inactive'}</Tag>,
    maxWidth: 100,
  },
];

export function FacilitySettings() {
  const [tab, setTab] = useState<FacilityTab>('courts');
  const [courts, setCourts] = useState<Facility[]>([]);
  const [showers, setShowers] = useState<Facility[]>([]);
  const [edit, setEdit] = useState<{ type: FacilityTab; facility: Facility | null } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.listAllCourts(), api.listAllShowers()]).then(([c, s]) => {
      setCourts(c ?? []);
      setShowers(s ?? []);
      setLoading(false);
    });
  }, []);

  useEffect(load, [load]);

  const facilities = tab === 'courts' ? courts : showers;

  return (
    <div className={styles.page}>
      <div
        style={{ display: 'flex', gap: 'var(--octa-space-1)' }}
        role="tablist"
        aria-label="Facility type"
      >
        <TabButton variant="pill" role="tab" aria-selected={tab === 'courts'} active={tab === 'courts'} onClick={() => setTab('courts')}>
          Courts
        </TabButton>
        <TabButton variant="pill" role="tab" aria-selected={tab === 'showers'} active={tab === 'showers'} onClick={() => setTab('showers')}>
          Showers
        </TabButton>
      </div>

      <div className={styles.tableArea}>
        <DataTable
          rows={facilities}
          columns={courtColumns}
          rowKey={(r) => r.id}
          onRowClick={(r) => setEdit({ type: tab, facility: r })}
          loading={loading}
          emptyMessage={`No ${tab} configured`}
        />
      </div>

      <button className={styles.addRow} onClick={() => setEdit({ type: tab, facility: null })}>
        <AppIcon name="plus" />
        Add {tab === 'courts' ? 'Court' : 'Shower'}
      </button>

      {edit && (
        <FacilityEditModal
          type={edit.type}
          facility={edit.facility}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); load(); }}
        />
      )}
    </div>
  );
}

function FacilityEditModal({
  type,
  facility,
  onClose,
  onSaved,
}: {
  type: FacilityTab;
  facility: Facility | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isCreate = !facility;
  const label = type === 'courts' ? 'Court' : 'Shower';

  const [name, setName] = useState(facility?.name ?? '');
  const [slotDuration, setSlotDuration] = useState(String(facility?.slotDurationMinutes ?? (type === 'courts' ? 60 : 30)));
  const [opStart, setOpStart] = useState(facility?.operatingHoursStart ?? '07:00');
  const [opEnd, setOpEnd] = useState(facility?.operatingHoursEnd ?? '22:00');
  const [maxAdvance, setMaxAdvance] = useState(String(facility?.maxAdvanceDays ?? 7));
  const [maxPerDay, setMaxPerDay] = useState(String(facility?.maxBookingsPerMemberPerDay ?? 2));
  const [cancelDeadline, setCancelDeadline] = useState(String(facility?.cancellationDeadlineMinutes ?? 60));
  const [active, setActive] = useState(facility?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookingCount, setBookingCount] = useState<number | null>(null);

  useEffect(() => {
    if (!facility) return;
    const facilityType = type === 'courts' ? 'court' as const : 'shower' as const;
    api.getFacilityBookingCount(facilityType, facility.id).then((r) => setBookingCount(r.count));
  }, [facility, type]);

  const showDeactivateWarning = !isCreate && facility?.active && !active && bookingCount != null && bookingCount > 0;

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const data = {
        name: name.trim(),
        slotDurationMinutes: parseInt(slotDuration, 10),
        operatingHoursStart: opStart,
        operatingHoursEnd: opEnd,
        maxAdvanceDays: parseInt(maxAdvance, 10),
        maxBookingsPerMemberPerDay: parseInt(maxPerDay, 10),
        cancellationDeadlineMinutes: parseInt(cancelDeadline, 10),
        ...(isCreate ? {} : { active }),
      };

      if (isCreate) {
        if (type === 'courts') await api.createCourt(data);
        else await api.createShower(data);
      } else {
        if (type === 'courts') await api.updateCourt(facility.id, data);
        else await api.updateShower(facility.id, data);
      }
      onSaved();
    } catch (e: any) {
      setError(e.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isCreate ? `Add ${label}` : `Edit ${label}`}
      width={420}
      error={error}
      footer={
        <ModalActions>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button color="primary" onClick={handleSave} loading={saving}>
            {isCreate ? 'Create' : 'Save'}
          </Button>
        </ModalActions>
      }
    >
      <div style={{ padding: 'var(--octa-space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--octa-space-3)' }}>
        <FormField label="Name">
          {(id) => <Input id={id} value={name} onValueChange={setName} />}
        </FormField>
        <FormField label="Slot duration (min)">
          {(id) => <Input id={id} value={slotDuration} onValueChange={setSlotDuration} type="number" />}
        </FormField>
        <FormField label="Operating hours">
          {() => (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--octa-space-2)' }}>
              <Input value={opStart} onValueChange={setOpStart} style={{ width: 80 }} />
              <Text intent="muted">to</Text>
              <Input value={opEnd} onValueChange={setOpEnd} style={{ width: 80 }} />
            </div>
          )}
        </FormField>
        <FormField label="Max advance booking (days)">
          {(id) => <Input id={id} value={maxAdvance} onValueChange={setMaxAdvance} type="number" />}
        </FormField>
        <FormField label="Max bookings per member/day">
          {(id) => <Input id={id} value={maxPerDay} onValueChange={setMaxPerDay} type="number" />}
        </FormField>
        <FormField label="Cancellation deadline (min)">
          {(id) => <Input id={id} value={cancelDeadline} onValueChange={setCancelDeadline} type="number" />}
        </FormField>
        {!isCreate && (
          <Toggle
            checked={active}
            onValueChange={setActive}
            label="Active"
          />
        )}
        {showDeactivateWarning && (
          <Callout intent="warning">
            {bookingCount} upcoming booking{bookingCount === 1 ? '' : 's'} will need to be manually cancelled or moved.
          </Callout>
        )}
      </div>
    </Modal>
  );
}
