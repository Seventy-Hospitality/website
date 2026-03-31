import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { DatePicker, Text, TabButton, Tag } from 'octahedron';
import { api } from '../lib/api';
import { AppShell } from '../components/AppShell';
import { AvailabilityGrid } from '../components/AvailabilityGrid';
import { BookingConfirmDialog } from '../components/BookingConfirmDialog';
import { BookingDetailDialog } from '../components/BookingDetailDialog';
import styles from './BookingsPage.module.css';

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

type Tab = 'courts' | 'showers' | 'bookings';

interface BookingInfo {
  id: string;
  facilityType: string;
  facilityId: string;
  startTime: string;
  endTime: string;
  memberId: string;
  member?: { firstName: string; lastName: string };
}

const VALID_TABS: Tab[] = ['courts', 'showers'];

export function BookingsPage() {
  const { tab: tabParam } = useParams<{ tab: string }>();
  const navigate = useNavigate();
  const tab: Tab = VALID_TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'courts';

  const today = useMemo(() => formatDate(new Date()), []);
  const maxDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return formatDate(d);
  }, []);

  const [selectedDate, setSelectedDate] = useState(today);
  const [courts, setCourts] = useState<any[]>([]);
  const [showers, setShowers] = useState<any[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Create booking dialog
  const [confirm, setConfirm] = useState<{
    type: 'court' | 'shower';
    facilityId: string;
    facilityName: string;
    startTime: string;
    endTime: string;
  } | null>(null);

  // Booking detail dialog (view/cancel existing booking)
  const [detail, setDetail] = useState<{
    booking: BookingInfo;
    facilityName: string;
  } | null>(null);

  const load = useCallback(() => {
    Promise.all([api.listCourts(), api.listShowers()]).then(([c, s]) => {
      setCourts(c ?? []);
      setShowers(s ?? []);
    });
  }, []);

  useEffect(load, [load]);

  function handleSlotClick(type: 'court' | 'shower', facilityId: string, slot: { startTime: string; endTime: string }) {
    const facilities = type === 'court' ? courts : showers;
    const facility = facilities.find((f: any) => f.id === facilityId);
    setConfirm({
      type,
      facilityId,
      facilityName: facility?.name ?? facilityId,
      startTime: slot.startTime,
      endTime: slot.endTime,
    });
  }

  function handleBookingClick(booking: BookingInfo, facilityName: string) {
    setDetail({ booking, facilityName });
  }

  function refresh() {
    setRefreshKey((k) => k + 1);
  }

  return (
    <AppShell>
      <div className={styles.page}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <Text variant="label" style={{ fontWeight: 'var(--octa-font-weight-semibold)' }}>
              {formatDisplayDate(selectedDate)}
            </Text>
            {selectedDate === today && <Tag variant="accent">Today</Tag>}
          </div>
          <DatePicker
            value={selectedDate}
            onValueChange={(v) => v && setSelectedDate(v)}
            min={today}
            max={maxDate}
          />
        </div>

        <div
          style={{ display: 'flex', gap: 'var(--octa-space-1)' }}
          role="tablist"
          aria-label="Booking sections"
        >
          <TabButton variant="cutout" role="tab" aria-selected={tab === 'courts'} active={tab === 'courts'} onClick={() => navigate('/bookings/courts')}>
            Courts
          </TabButton>
          <TabButton variant="cutout" role="tab" aria-selected={tab === 'showers'} active={tab === 'showers'} onClick={() => navigate('/bookings/showers')}>
            Showers
          </TabButton>
        </div>

        <div className={styles.content}>
          {tab === 'courts' && (
            <div className={styles.gridArea}>
              <AvailabilityGrid
                key={`courts-${selectedDate}-${refreshKey}`}
                type="court"
                facilities={courts}
                date={selectedDate}
                onSlotClick={(fId, slot) => handleSlotClick('court', fId, slot)}
                onBookingClick={handleBookingClick}
              />
            </div>
          )}

          {tab === 'showers' && (
            <div className={styles.gridArea}>
              <AvailabilityGrid
                key={`showers-${selectedDate}-${refreshKey}`}
                type="shower"
                facilities={showers}
                date={selectedDate}
                onSlotClick={(fId, slot) => handleSlotClick('shower', fId, slot)}
                onBookingClick={handleBookingClick}
              />
            </div>
          )}

        </div>

        {confirm && (
          <BookingConfirmDialog
            type={confirm.type}
            facilityId={confirm.facilityId}
            facilityName={confirm.facilityName}
            date={selectedDate}
            startTime={confirm.startTime}
            endTime={confirm.endTime}
            onConfirm={() => { setConfirm(null); refresh(); }}
            onClose={() => setConfirm(null)}
          />
        )}

        {detail && (
          <BookingDetailDialog
            booking={detail.booking}
            facilityName={detail.facilityName}
            date={selectedDate}
            onCancelled={() => { setDetail(null); refresh(); }}
            onClose={() => setDetail(null)}
          />
        )}
      </div>
    </AppShell>
  );
}
