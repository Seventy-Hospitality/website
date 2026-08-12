import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, SearchX, X } from 'lucide-react';
import { api } from '../../lib/api';
import { formatDateHeading, formatTimeRangeCompact } from '../../lib/booking';
import {
  EMPTY_INVITE_SELECTION,
  inviteCount,
  inviteesPayload,
  type InviteSelection,
} from '../../lib/invites';
import { Button, ButtonLink, EmptyState, FullScreenLoader, useToast } from '../../components';
import { reservationQuery } from '../reserve/booking-data';
import { InvitePlayersStep } from '../reserve/InvitePlayersStep';
import styles from '../reserve/wizard.module.css';

/**
 * "Invite more players" from the reservation detail (and from the
 * post-edit success modal): the W3 invite step (member search + club
 * "Add all" chips) run full-screen against an existing reservation.
 * POST /api/reservations/:id/participants; permission is the backend's
 * canInvite (organizer + confirmed participants, active reservations).
 */
export function InviteParticipantsPage() {
  const { reservationId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const detail = useQuery(reservationQuery(reservationId));
  const [selection, setSelection] = useState<InviteSelection>(EMPTY_INVITE_SELECTION);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [detail.isSuccess]);

  const backToDetail = () => navigate(`/reservations/${reservationId}`);

  const invite = useMutation({
    mutationFn: async (picked: InviteSelection) => {
      const payload = inviteesPayload(picked);
      if (!payload) return null;
      await api.addReservationParticipants(reservationId, payload);
      return api.getReservation(reservationId);
    },
    onSuccess: (fresh) => {
      if (fresh) {
        queryClient.setQueryData(['reservations', reservationId], fresh);
        void queryClient.invalidateQueries({ queryKey: ['reservations'] });
        void queryClient.invalidateQueries({ queryKey: ['home'] });
      }
      toast({ variant: 'success', message: 'Invites sent' });
      backToDetail();
    },
  });

  const frame = (children: React.ReactNode) => (
    <div className={styles.page}>
      <div className={styles.column}>
        <header className={styles.chrome}>
          <button
            type="button"
            className={styles.chromeButton}
            onClick={backToDetail}
            aria-label="Back to reservation"
          >
            <ArrowLeft aria-hidden />
          </button>
          <button
            type="button"
            className={styles.chromeButton}
            onClick={backToDetail}
            aria-label="Close"
          >
            <X aria-hidden />
          </button>
        </header>
        {children}
      </div>
    </div>
  );

  if (detail.isPending) {
    return <FullScreenLoader label="Loading reservation" />;
  }

  if (detail.isError) {
    return frame(
      <EmptyState
        icon={<SearchX aria-hidden />}
        title="Reservation not found"
        description="This reservation does not exist, was removed, or you are not part of it."
        action={<ButtonLink to="/">Back to home</ButtonLink>}
      />,
    );
  }

  const reservation = detail.data;
  if (!reservation.viewer?.canInvite) {
    return frame(
      <EmptyState
        icon={<SearchX aria-hidden />}
        title="Inviting is not available"
        description="Only the organizer and confirmed players can invite to an upcoming reservation."
        action={<Button onClick={backToDetail}>Back to reservation</Button>}
      />,
    );
  }

  return frame(
    <InvitePlayersStep
      headingRef={headingRef}
      subtitle={`${formatDateHeading(reservation.date)} · ${formatTimeRangeCompact(reservation.startTime, reservation.endTime)}`}
      selection={selection}
      onSelectionChange={setSelection}
      excludeMemberIds={reservation.participants
        .filter((row) => row.status === 'pending' || row.status === 'confirmed')
        .map((row) => row.memberId)}
      continueLabel="Send invites"
      continueDisabled={inviteCount(selection) === 0}
      continuePending={invite.isPending}
      error={invite.isError ? 'We could not send those invites. Try again.' : null}
      onContinue={() => invite.mutate(selection)}
    />,
  );
}
