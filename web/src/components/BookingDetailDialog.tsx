import { useState } from 'react';
import { Modal, ModalActions, ControlButton, KeyValueList, type KeyValueListItem } from 'octahedron';
import { api, ApiError } from '../lib/api';

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
  booking: BookingInfo;
  facilityName: string;
  date: string;
  onCancelled: () => void;
  onClose: () => void;
}

export function BookingDetailDialog({ booking, facilityName, date, onCancelled, onClose }: Props) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memberName = booking.member
    ? `${booking.member.firstName} ${booking.member.lastName}`
    : booking.memberId;

  const rows: KeyValueListItem[] = [
    { label: 'Facility', value: facilityName },
    { label: 'Date', value: date },
    { label: 'Time', value: `${booking.startTime}–${booking.endTime}` },
    { label: 'Member', value: memberName },
  ];

  async function handleCancel() {
    setCancelling(true);
    setError(null);
    try {
      if (booking.facilityType === 'court') {
        await api.cancelCourtBooking(booking.facilityId, booking.id);
      } else {
        await api.cancelShowerBooking(booking.facilityId, booking.id);
      }
      onCancelled();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to cancel');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Booking Details"
      width={380}
      error={error}
      footer={
        <ModalActions>
          <ControlButton onClick={onClose}>Close</ControlButton>
          <ControlButton color="danger" onClick={handleCancel} loading={cancelling}>
            Cancel Booking
          </ControlButton>
        </ModalActions>
      }
    >
      <div style={{ padding: 'var(--gs-space-4)' }}>
        <KeyValueList items={rows} labelWidthPx={72} />
      </div>
    </Modal>
  );
}
