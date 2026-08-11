import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Ellipsis, SearchX } from 'lucide-react';
import {
  api,
  ApiError,
  type Reservation,
  type ReservationParticipant,
  type ReservationParticipantStatus,
  type ReservationViewer,
} from '../../lib/api';
import {
  bookingRefLabel,
  formatDateLong,
  formatDuration,
  formatTimeRangeCompact,
} from '../../lib/booking';
import { formatAmountWithCents } from '../../lib/plan-pricing';
import { memberDisplayName } from '../../lib/invites';
import {
  cancelRefundPreview,
  hasReservationStarted,
  isActiveReservationStatus,
} from '../../lib/reservation-policy';
import { useRespondToReservation, isRespondConflict } from '../../lib/reservation-respond';
import { useSession } from '../../lib/session-context';
import {
  Avatar,
  Button,
  ButtonLink,
  EmptyState,
  ReservationCard,
  Sheet,
  Skeleton,
  useToast,
} from '../../components';
import { PageHeader } from '../../app/AppShell';
import { reservationQuery } from '../reserve/booking-data';
// The section-head styling is the wizard's (sectionHead/sectionLabel/
// sectionCount/sectionLink); reuse it instead of redefining the pattern.
import wizardStyles from '../reserve/wizard.module.css';
import styles from './reservations.module.css';

type ReservationDetail = Reservation & { viewer: ReservationViewer };

const STATUS_LABELS: Record<ReservationParticipantStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

/**
 * Reservation detail (Figma reservation-details 225:3330 / 225:3586 /
 * 159:13854): the booking card, the PLAYERS roster with per-player
 * statuses, and actions driven by the backend's viewer capabilities:
 *
 * - organizer: Edit reservation / Cancel reservation / Invite, plus a
 *   per-player overflow (remove, re-invite);
 * - invited guest (own row pending): ACCEPT / DECLINE pills;
 * - accepted guest: "Decline reservation" (withdraw, with confirmation).
 */
export function ReservationDetailPage() {
  const { reservationId = '' } = useParams();
  const detail = useQuery(reservationQuery(reservationId));

  if (detail.isPending) {
    return (
      <div className={styles.detail}>
        <BackToHome />
        <PageHeader title="Reservation details" />
        <div aria-busy="true" role="status" className={styles.dialogBody}>
          <span className="visually-hidden">Loading reservation</span>
          <Skeleton height="9rem" shape="card" />
          <Skeleton height="16rem" shape="card" />
        </div>
      </div>
    );
  }

  if (detail.isError) {
    const error = detail.error;
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      // The backend answers 404 for outsiders on purpose (a reservation
      // you are not part of looks exactly like one that does not exist).
      return (
        <div className={styles.detail}>
          <BackToHome />
          <PageHeader title="Reservation details" />
          <EmptyState
            icon={<SearchX aria-hidden />}
            title="Reservation not found"
            description="This reservation does not exist, was removed, or you are not part of it."
            action={<ButtonLink to="/">Back to home</ButtonLink>}
          />
        </div>
      );
    }
    return (
      <div className={styles.detail}>
        <BackToHome />
        <PageHeader title="Reservation details" />
        <div className={styles.banner} role="alert">
          <p>We could not load this reservation.</p>
          <Button variant="secondary" size="sm" onClick={() => void detail.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return <ReservationDetailView detail={detail.data as ReservationDetail} />;
}

function BackToHome() {
  return (
    <Link to="/" className={styles.backLink}>
      <ChevronLeft aria-hidden />
      Back to home
    </Link>
  );
}

function ReservationDetailView({ detail }: { detail: ReservationDetail }) {
  const { memberId } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [playerMenu, setPlayerMenu] = useState<ReservationParticipant | null>(null);

  const viewer = detail.viewer;
  const active = isActiveReservationStatus(detail.status);
  const started = hasReservationStarted(detail);
  const myStatus = detail.participants.find((row) => row.memberId === memberId)?.status ?? null;

  const respond = useRespondToReservation();

  function respondWith(response: 'accept' | 'decline') {
    respond.mutate(
      { reservationId: detail.id, response },
      {
        onError: (error) => {
          toast({
            variant: 'error',
            message: isRespondConflict(error)
              ? 'This reservation changed before your response was saved.'
              : 'We could not save your response. Try again.',
          });
        },
      },
    );
  }

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelReservation(detail.id),
    onSuccess: ({ refundCents }) => {
      setCancelOpen(false);
      queryClient.setQueryData(['reservations', detail.id], {
        ...detail,
        status: 'cancelled' as const,
      });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      void queryClient.invalidateQueries({ queryKey: ['availability', detail.typeCode] });
      toast({
        variant: 'success',
        message:
          refundCents > 0
            ? `Reservation cancelled. ${formatAmountWithCents(refundCents)} will be refunded to your card.`
            : 'Reservation cancelled.',
      });
    },
    onError: (error) => {
      setCancelOpen(false);
      if (error instanceof ApiError && error.code === 'ALREADY_STARTED') {
        toast({ variant: 'error', message: 'This booking has already started and can no longer be cancelled.' });
      } else if (error instanceof ApiError && (error.code === 'INVALID_STATUS' || error.status === 404)) {
        toast({ variant: 'error', message: 'This reservation has already been resolved.' });
        void queryClient.invalidateQueries({ queryKey: ['reservations', detail.id] });
      } else {
        toast({ variant: 'error', message: 'We could not cancel this reservation. Try again.' });
      }
    },
  });

  const removeMutation = useMutation({
    mutationFn: (target: ReservationParticipant) =>
      api.removeReservationParticipant(detail.id, target.memberId),
    onSuccess: (_result, target) => {
      setPlayerMenu(null);
      queryClient.setQueryData(['reservations', detail.id], {
        ...detail,
        participants: detail.participants.filter((row) => row.memberId !== target.memberId),
      });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      toast({ variant: 'success', message: `${memberDisplayName(target)} was removed.` });
    },
    onError: () => {
      setPlayerMenu(null);
      toast({ variant: 'error', message: 'We could not remove that player. Try again.' });
      void queryClient.invalidateQueries({ queryKey: ['reservations', detail.id] });
    },
  });

  const reinviteMutation = useMutation({
    mutationFn: (target: ReservationParticipant) =>
      api.addReservationParticipants(detail.id, { memberIds: [target.memberId] }),
    onSuccess: (_result, target) => {
      setPlayerMenu(null);
      queryClient.setQueryData(['reservations', detail.id], {
        ...detail,
        participants: detail.participants.map((row) =>
          row.memberId === target.memberId ? { ...row, status: 'pending' as const } : row,
        ),
      });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      toast({ variant: 'success', message: `Invite sent to ${memberDisplayName(target)}.` });
    },
    onError: () => {
      setPlayerMenu(null);
      toast({ variant: 'error', message: 'We could not send that invite. Try again.' });
    },
  });

  const refund = cancelRefundPreview(detail);

  return (
    <div className={styles.detail}>
      <BackToHome />
      <PageHeader title="Reservation details" />

      {detail.status === 'cancelled' && (
        <div className={[styles.banner, styles.bannerDanger].join(' ')} role="status">
          <p>This reservation was cancelled.</p>
        </div>
      )}
      {detail.status === 'expired' && (
        <div className={[styles.banner, styles.bannerDanger].join(' ')} role="status">
          <p>This booking expired before its payment was completed.</p>
        </div>
      )}
      {detail.status === 'pending_payment' && (
        <div className={styles.banner} role="status">
          <p>This booking is awaiting payment.</p>
        </div>
      )}
      {detail.pendingChange && viewer.canManage && (
        <div className={styles.banner} role="status">
          <p>
            A change to {formatDateLong(detail.pendingChange.date)},{' '}
            {formatTimeRangeCompact(detail.pendingChange.startTime, detail.pendingChange.endTime)}{' '}
            is awaiting payment. Your current time is kept until the change is paid for.
          </p>
        </div>
      )}

      <ReservationCard
        typeCode={detail.typeCode}
        typeName={detail.typeName}
        resourceName={detail.resource.name}
        rows={[
          { label: 'Date', value: formatDateLong(detail.date) },
          { label: 'Time', value: formatTimeRangeCompact(detail.startTime, detail.endTime) },
          { label: 'Duration', value: formatDuration(detail.durationMinutes) },
        ]}
      />
      <p className={styles.meta}>
        <span>
          Booking ref <span className={styles.metaValue}>{bookingRefLabel(detail.reference)}</span>
        </span>
        {detail.amountPaidCents > 0 && (
          <span>
            Amount paid{' '}
            <span className={styles.metaValue}>
              {formatAmountWithCents(detail.amountPaidCents)}
            </span>
          </span>
        )}
      </p>

      <PlayersHead
        count={detail.participants.length}
        onInvite={
          viewer.canInvite ? () => navigate(`/reservations/${detail.id}/invite`) : undefined
        }
      />

      <ul className={styles.roster} aria-label="Players">
        {detail.participants.map((participant) => {
          const isSelf = participant.memberId === memberId;
          const name = memberDisplayName(participant);
          const showRespondPills = isSelf && viewer.canRespond && participant.status === 'pending';
          const showMenu =
            viewer.canManage && active && !isSelf && participant.role !== 'organizer';
          return (
            <li key={participant.memberId} className={styles.playerRow}>
              <Avatar name={name} size="md" />
              <span className={styles.playerName}>
                {name}
                {isSelf && <span className="visually-hidden"> (you)</span>}
              </span>
              {showRespondPills ? (
                <span
                  className={styles.respondActions}
                  role="group"
                  aria-label="Respond to this invitation"
                >
                  <button
                    type="button"
                    className={[styles.respondPill, styles.respondAccept].join(' ')}
                    disabled={respond.isPending}
                    onClick={() => respondWith('accept')}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className={[styles.respondPill, styles.respondDecline].join(' ')}
                    disabled={respond.isPending}
                    onClick={() => respondWith('decline')}
                  >
                    Decline
                  </button>
                </span>
              ) : (
                <span
                  className={[
                    styles.playerStatus,
                    participant.status === 'confirmed' ? styles.playerStatusConfirmed : '',
                    participant.status === 'declined' || participant.status === 'withdrawn'
                      ? styles.playerStatusDeclined
                      : '',
                  ].join(' ')}
                >
                  {STATUS_LABELS[participant.status]}
                  <span className="visually-hidden">: {name}</span>
                </span>
              )}
              {showMenu && (
                <button
                  type="button"
                  className={styles.playerMenuButton}
                  aria-label={`Actions for ${name}`}
                  aria-haspopup="dialog"
                  onClick={() => setPlayerMenu(participant)}
                >
                  <Ellipsis aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/* ── Bottom actions by role ── */}

      {viewer.canManage && !started && (
        <div className={styles.actions}>
          {detail.status === 'confirmed' && (
            <ButtonLink to={`/reservations/${detail.id}/edit`} fullWidth>
              Edit reservation
            </ButtonLink>
          )}
          {active && (
            <button type="button" className={styles.textAction} onClick={() => setCancelOpen(true)}>
              Cancel reservation
            </button>
          )}
        </div>
      )}

      {viewer.canRespond && myStatus === 'confirmed' && !started && (
        <div className={styles.actions}>
          <button type="button" className={styles.textAction} onClick={() => setWithdrawOpen(true)}>
            Decline reservation
          </button>
        </div>
      )}

      {/* ── Cancel confirmation with the tiered-refund preview ── */}

      <Sheet
        open={cancelOpen}
        onClose={() => {
          if (!cancelMutation.isPending) setCancelOpen(false);
        }}
        title="Cancel reservation"
        footer={
          <div className={styles.dialogActions}>
            <Button
              variant="danger"
              fullWidth
              loading={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              Cancel reservation
            </Button>
            <Button
              variant="secondary"
              fullWidth
              disabled={cancelMutation.isPending}
              onClick={() => setCancelOpen(false)}
            >
              Keep reservation
            </Button>
          </div>
        }
      >
        <div className={styles.dialogBody}>
          <p className={styles.dialogText}>
            Cancel your {detail.typeName} booking on {formatDateLong(detail.date)},{' '}
            {formatTimeRangeCompact(detail.startTime, detail.endTime)}?
          </p>
          {refund.netPaidCents > 0 ? (
            <>
              <div className={styles.refundSummary}>
                <span className={styles.refundRow}>
                  <span>Refund to your card ({refund.percent}%)</span>
                </span>
                <span className={styles.refundAmount}>
                  {formatAmountWithCents(refund.refundCents)}
                </span>
              </div>
              <p className={styles.dialogHint}>{refundTierHint(refund.percent)}</p>
            </>
          ) : (
            <p className={styles.dialogHint}>You have not been charged for this booking.</p>
          )}
        </div>
      </Sheet>

      {/* ── Withdraw (decline after accepting) confirmation ── */}

      <Sheet
        open={withdrawOpen}
        onClose={() => {
          if (!respond.isPending) setWithdrawOpen(false);
        }}
        title="Decline reservation"
        footer={
          <div className={styles.dialogActions}>
            <Button
              variant="danger"
              fullWidth
              loading={respond.isPending}
              onClick={() => {
                respondWith('decline');
                setWithdrawOpen(false);
              }}
            >
              Decline reservation
            </Button>
            <Button
              variant="secondary"
              fullWidth
              disabled={respond.isPending}
              onClick={() => setWithdrawOpen(false)}
            >
              Keep my spot
            </Button>
          </div>
        }
      >
        <div className={styles.dialogBody}>
          <p className={styles.dialogText}>
            You are confirmed for this booking. Declining gives up your spot, and you would need
            a new invitation to rejoin.
          </p>
        </div>
      </Sheet>

      {/* ── Organizer's per-player actions ── */}

      <Sheet
        open={playerMenu !== null}
        onClose={() => {
          if (!removeMutation.isPending && !reinviteMutation.isPending) setPlayerMenu(null);
        }}
        title={playerMenu ? memberDisplayName(playerMenu) : 'Player'}
        footer={
          playerMenu && (
            <div className={styles.dialogActions}>
              {(playerMenu.status === 'declined' || playerMenu.status === 'withdrawn') && (
                <Button
                  fullWidth
                  loading={reinviteMutation.isPending}
                  disabled={removeMutation.isPending}
                  onClick={() => reinviteMutation.mutate(playerMenu)}
                >
                  Send invite again
                </Button>
              )}
              <Button
                variant="danger"
                fullWidth
                loading={removeMutation.isPending}
                disabled={reinviteMutation.isPending}
                onClick={() => removeMutation.mutate(playerMenu)}
              >
                Remove from booking
              </Button>
            </div>
          )
        }
      >
        {playerMenu && (
          <div className={styles.dialogBody}>
            <p className={styles.dialogHint}>
              {playerMenu.status === 'declined' || playerMenu.status === 'withdrawn'
                ? `${memberDisplayName(playerMenu)} declined this booking. You can invite them again or remove them from the list.`
                : `Removing ${memberDisplayName(playerMenu)} takes them off this booking; they can be invited again later.`}
            </p>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function PlayersHead({ count, onInvite }: { count: number; onInvite?: () => void }) {
  return (
    <div className={wizardStyles.sectionHead}>
      <span className={wizardStyles.sectionLabel}>
        Players <span className={wizardStyles.sectionCount}>{count}</span>
      </span>
      {onInvite && (
        <button type="button" className={wizardStyles.sectionLink} onClick={onInvite}>
          Invite
        </button>
      )}
    </div>
  );
}

function refundTierHint(percent: 100 | 50 | 0): string {
  if (percent === 100) {
    return 'Cancelling more than 24 hours before the start time refunds the full amount.';
  }
  if (percent === 50) {
    return 'Cancelling between 2 and 24 hours before the start time refunds half of what you paid.';
  }
  return 'Cancelling within 2 hours of the start time is non-refundable.';
}
