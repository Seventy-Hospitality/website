import { useCallback, useEffect, useState } from 'react';
import { Button, Tag, Text, EmptyState } from 'octahedron';
import { api } from '../lib/api';
import styles from './MyBookingsList.module.css';

interface Booking {
  id: string;
  facilityType: 'court' | 'shower';
  facilityId: string;
  date: string;
  startTime: string;
  endTime: string;
}

interface Props {
  onBookingCancelled?: () => void;
}

export function MyBookingsList({ onBookingCancelled }: Props) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getMyBookings()
      .then((data) => setBookings(data ?? []))
      .finally(() => setLoading(false));
  }, []);

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
  if (bookings.length === 0) return <EmptyState title="No upcoming bookings" description="Book a court or shower to get started" />;

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
                {new Date(b.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </Text>
              <Text variant="caption" intent="muted">{b.startTime}–{b.endTime}</Text>
            </div>
          </div>
          <Button
            variant="ghost"
            color="danger"
            compact
            onClick={() => handleCancel(b)}
            loading={cancelling === b.id}
          >
            Cancel
          </Button>
        </div>
      ))}
    </div>
  );
}
