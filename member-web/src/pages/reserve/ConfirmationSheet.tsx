import { useNavigate } from 'react-router-dom';
import type { Reservation, ReservationParticipantStatus } from '../../lib/api';
import {
  bookingRefLabel,
  formatDateFull,
  formatTimeRangeCompact,
  resourceNoun,
} from '../../lib/booking';
import { formatAmountWithCents } from '../../lib/plan-pricing';
import { memberDisplayName } from '../../lib/invites';
import { Avatar, Button, ReservationCard, Sheet } from '../../components';
import styles from './wizard.module.css';

const STATUS_LABELS: Record<ReservationParticipantStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

export interface ConfirmationSheetProps {
  reservation: Reservation;
  onInviteMore: () => void;
  onClose: () => void;
}

/**
 * The success sheet (Figma confirmation 7:2772): booking details with the
 * booking ref and amount paid, the player roster with per-player statuses,
 * and the "Invite more players" / "Go to reservation" actions. Built on
 * the kit Sheet (native dialog: focus trap, Escape, inert background).
 * The reservation detail route belongs to W4; the link works either way.
 */
export function ConfirmationSheet({ reservation, onInviteMore, onClose }: ConfirmationSheetProps) {
  const navigate = useNavigate();
  const noun = resourceNoun(reservation.typeName);

  // Guests the organizer removed or who declined still exist as rows; the
  // roster shows everyone who is on (or pending for) the booking.
  const roster = reservation.participants.filter(
    (participant) => participant.status === 'confirmed' || participant.status === 'pending',
  );

  return (
    <Sheet open onClose={onClose} title="Booking confirmed">
      <div className={styles.confirmation}>
        <h3 className={styles.confirmationTitle}>Your {noun} booking is confirmed</h3>
        <p className={styles.confirmationCaption}>
          A confirmation has been sent to your email
        </p>

        <ReservationCard
          typeCode={reservation.typeCode}
          typeName={reservation.typeName}
          resourceName={reservation.resource.name}
          layout="rows"
          rows={[
            { label: 'Date', value: formatDateFull(reservation.date) },
            {
              label: 'Time',
              value: formatTimeRangeCompact(reservation.startTime, reservation.endTime),
            },
            { label: 'Booking ref', value: bookingRefLabel(reservation.reference) },
            { label: 'Amount paid', value: formatAmountWithCents(reservation.amountPaidCents) },
          ]}
        />

        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>
            Players <span className={styles.sectionCount}>{roster.length}</span>
          </span>
        </div>

        <ul className={styles.confirmationRoster}>
          {roster.map((participant) => {
            const name = memberDisplayName(participant);
            return (
              <li key={participant.memberId} className={styles.confirmationPlayer}>
                <Avatar name={name} size="md" />
                <span className={styles.confirmationPlayerName}>{name}</span>
                <span
                  className={[
                    styles.confirmationStatus,
                    participant.status === 'confirmed' ? styles.confirmationStatusConfirmed : '',
                  ].join(' ')}
                >
                  {STATUS_LABELS[participant.status]}
                </span>
              </li>
            );
          })}
        </ul>

        <div className={styles.confirmationActions}>
          <Button fullWidth onClick={onInviteMore}>
            Invite more players
          </Button>
          <button
            type="button"
            className={styles.confirmationLink}
            onClick={() => navigate(`/reservations/${reservation.id}`)}
          >
            Go to reservation
          </button>
        </div>
      </div>
    </Sheet>
  );
}
