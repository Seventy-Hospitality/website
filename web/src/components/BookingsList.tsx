import { useCallback, useEffect, useState } from 'react';
import { ControlButton, Tag, Text, EmptyState } from 'octahedron';
import { api } from '../lib/api';
import styles from './BookingsList.module.css';

interface Booking {
  id: string;
  facilityType: 'court' | 'shower';
  facilityId: string;
  memberId: string;
  date: string;
  startTime: string;
  endTime: string;
  member?: { firstName: string; lastName: string; email: string };
}

interface Props {
  date: string;
  refreshKey: number;
  onBookingCancelled?: () => void;
}

export function BookingsList({ date, refreshKey, onBookingCancelled }: Props) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.listBookings(date)
      .then((data) => setBookings(data ?? []))
      .finally(() => setLoading(false));
  }, [date, refreshKey]);

  useEffect(load, [load]);

  async function handleCancel(booking: Booking) {
    setCancelling(booking.id);
    try {
      if (booking.facilityType === 'court') {
        await api.cancelCourtBooking(booking.facilityId, booking.id);
      } else {
        await api.cancelShowerBooking(booking.facilityId, booking.id);
      }
      load();
      onBookingCancelled?.();
    } finally {
      setCancelling(null);
    }
  }

  if (loading) return <Text intent="muted">Loading...</Text>;
  if (bookings.length === 0) return <EmptyState title="No bookings" description="No bookings for this date" />;

  return (
    <div className={styles.list}>
      {bookings.map((b) => (
        <div key={b.id} className={styles.item}>
          <div className={styles.itemLeft}>
            <Tag variant={b.facilityType === 'court' ? 'accent' : 'info'}>
              {b.facilityType === 'court' ? 'Court' : 'Shower'}
            </Tag>
            <div className={styles.itemInfo}>
              <Text variant="label">
                {b.member ? `${b.member.firstName} ${b.member.lastName}` : b.memberId}
              </Text>
              <Text variant="caption" intent="muted">{b.startTime}–{b.endTime}</Text>
            </div>
          </div>
          <ControlButton
            variant="ghost"
            color="danger"
            compact
            onClick={() => handleCancel(b)}
            loading={cancelling === b.id}
          >
            Cancel
          </ControlButton>
        </div>
      ))}
    </div>
  );
}
