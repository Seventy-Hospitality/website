import { useCallback, useEffect, useState } from 'react';
import { Text, SkeletonBar, EmptyState, Tooltip } from 'octahedron';
import { api } from '../lib/api';
import styles from './AvailabilityGrid.module.css';

interface Slot {
  startTime: string;
  endTime: string;
}

interface Facility {
  id: string;
  name: string;
  slotDurationMinutes: number;
  operatingHoursStart: string;
  operatingHoursEnd: string;
}

interface BookingInfo {
  id: string;
  facilityType: string;
  facilityId: string;
  startTime: string;
  endTime: string;
  memberId: string;
  member?: { firstName: string; lastName: string };
}

interface Props {
  type: 'court' | 'shower';
  facilities: Facility[];
  date: string;
  onSlotClick: (facilityId: string, slot: Slot) => void;
  onBookingClick: (booking: BookingInfo, facilityName: string) => void;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function generateAllSlots(start: string, end: string, duration: number): Slot[] {
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  const slots: Slot[] = [];
  for (let m = startMin; m + duration <= endMin; m += duration) {
    const sh = Math.floor(m / 60);
    const sm = m % 60;
    const eh = Math.floor((m + duration) / 60);
    const em = (m + duration) % 60;
    slots.push({
      startTime: `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`,
      endTime: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
    });
  }
  return slots;
}

function getHourRange(start: string, end: string): number[] {
  const startH = parseInt(start.split(':')[0], 10);
  const endH = parseInt(end.split(':')[0], 10);
  const hours: number[] = [];
  for (let h = startH; h < endH; h++) hours.push(h);
  return hours;
}

function formatHour(hour: number): string {
  if (hour === 0) return '12a';
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return '12p';
  return `${hour - 12}p`;
}

export function AvailabilityGrid({ type, facilities, date, onSlotClick, onBookingClick }: Props) {
  const [available, setAvailable] = useState<Record<string, Set<string>>>({});
  // Map of facilityId -> startTime -> BookingInfo
  const [bookings, setBookings] = useState<Record<string, Record<string, BookingInfo>>>({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!date || facilities.length === 0) return;
    setLoading(true);
    try {
      const fetcher = type === 'court' ? api.getCourtAvailability : api.getShowerAvailability;

      const [availResults, allBookings] = await Promise.all([
        Promise.all(
          facilities.map(async (f) => {
            const slots: Slot[] = await fetcher(f.id, date);
            return { id: f.id, available: new Set(slots.map((s) => s.startTime)) };
          }),
        ),
        api.listBookings(date),
      ]);

      const availMap: Record<string, Set<string>> = {};
      for (const r of availResults) availMap[r.id] = r.available;
      setAvailable(availMap);

      const bookingMap: Record<string, Record<string, BookingInfo>> = {};
      for (const b of (allBookings ?? [])) {
        if (b.facilityType !== type) continue;
        if (!bookingMap[b.facilityId]) bookingMap[b.facilityId] = {};
        bookingMap[b.facilityId][b.startTime] = b;
      }
      setBookings(bookingMap);
    } finally {
      setLoading(false);
    }
  }, [type, facilities, date]);

  useEffect(() => { load(); }, [load]);

  if (facilities.length === 0) {
    return <EmptyState title={`No ${type}s configured`} />;
  }

  if (loading) {
    return (
      <div className={styles.loading}>
        {facilities.map((f) => (
          <div key={f.id} className={styles.loadingRow}>
            <Text variant="label" className={styles.loadingLabel}>{f.name}</Text>
            <SkeletonBar width="100%" />
          </div>
        ))}
      </div>
    );
  }

  const ref = facilities[0];
  const allSlots = generateAllSlots(ref.operatingHoursStart, ref.operatingHoursEnd, ref.slotDurationMinutes);
  const hours = getHourRange(ref.operatingHoursStart, ref.operatingHoursEnd);
  const slotsPerHour = allSlots.length / hours.length;
  const totalSlotCols = allSlots.length;
  const gridTemplateColumns = `88px repeat(${totalSlotCols}, 1fr)`;

  return (
    <div className={styles.grid} style={{ gridTemplateColumns }}>
      {/* Time ruler */}
      <div className={styles.rulerLabel} />
      {hours.map((h) => (
        <div
          key={h}
          className={styles.rulerHour}
          style={{ gridColumn: `span ${slotsPerHour}` }}
        >
          {formatHour(h)}
        </div>
      ))}

      {/* Facility rows */}
      {facilities.map((facility, fi) => {
        const availSet = available[facility.id] ?? new Set();
        const facilityBookings = bookings[facility.id] ?? {};
        const isLast = fi === facilities.length - 1;

        return [
          <div key={`${facility.id}-label`} className={`${styles.facilityName} ${isLast ? styles.lastRow : ''}`}>
            {facility.name}
          </div>,
          ...allSlots.map((slot) => {
            const isAvailable = availSet.has(slot.startTime);
            const booking = facilityBookings[slot.startTime];
            const lastRowClass = isLast ? styles.lastRow : '';

            if (isAvailable) {
              return (
                <Tooltip delay={0} key={`${facility.id}-${slot.startTime}`} content={`${slot.startTime}–${slot.endTime} · Available`}>
                  <button
                    className={`${styles.slotAvailable} ${lastRowClass}`}
                    onClick={() => onSlotClick(facility.id, slot)}
                  />
                </Tooltip>
              );
            }

            const memberName = booking?.member
              ? `${booking.member.firstName} ${booking.member.lastName}`
              : 'Booked';

            return (
              <Tooltip delay={0} key={`${facility.id}-${slot.startTime}`} content={`${slot.startTime}–${slot.endTime} · ${memberName}`}>
                <button
                  className={`${styles.slotBooked} ${lastRowClass}`}
                  onClick={() => booking && onBookingClick(booking, facility.name)}
                />
              </Tooltip>
            );
          }),
        ];
      })}
    </div>
  );
}
