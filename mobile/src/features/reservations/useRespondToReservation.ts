/**
 * The shared invitation-response mutation (POST /api/reservations/:id/
 * respond). M4's detail screen and M2's home cards render the same
 * ACCEPT / DECLINE actions, so the cache discipline lives here once and is
 * exported for both. Ported from member-web/src/lib/reservation-respond.ts.
 *
 * - optimistic: the viewer's row in the ['reservations', id] detail cache
 *   (participants + myParticipation + viewer.status) flips immediately,
 *   with a snapshot rollback on error;
 * - optimistic on home too: the ['home'] feed moves an accepted invitation
 *   card into the upcoming list (and drops a declined one) immediately,
 *   with the same snapshot rollback;
 * - conflicts (the reservation was cancelled/expired mid-flight, or the
 *   invite was revoked) re-fetch the truth instead of trusting the cache;
 * - settlement invalidates the ['reservations'] and ['home'] prefixes so
 *   every surface converges on the server state.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type HomeFeed, type Reservation, type ReservationViewer } from '../../lib/api';
import { useSession } from '../../lib/session';
import { applyParticipantResponse, type ParticipantResponse } from './reservation-policy';

type ReservationDetail = Reservation & { viewer?: ReservationViewer };

export interface RespondInput {
  reservationId: string;
  response: ParticipantResponse;
}

/** Error codes meaning "the reservation moved on; re-check it". */
export function isRespondConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'INVALID_STATUS' ||
      error.code === 'INVALID_RESPONSE' ||
      error.code === 'NOT_FOUND')
  );
}

/** The optimistic detail-cache write for a response by `memberId`. */
export function applyResponseToDetail<T extends ReservationDetail>(
  detail: T,
  memberId: string,
  response: ParticipantResponse,
): T {
  const next = applyParticipantResponse(
    detail.participants.find((row) => row.memberId === memberId)?.status ?? 'pending',
    response,
  );
  if (next === null) return detail;
  return {
    ...detail,
    participants: detail.participants.map((row) =>
      row.memberId === memberId ? { ...row, status: next } : row,
    ),
    ...(detail.myParticipation
      ? { myParticipation: { ...detail.myParticipation, status: next } }
      : {}),
    ...(detail.viewer ? { viewer: { ...detail.viewer, status: next } } : {}),
  };
}

/**
 * The optimistic home-feed write for a response by `memberId`: accepting a
 * pending invitation moves its card into the upcoming list (viewer row
 * flipped to confirmed, list re-sorted by start), declining removes it.
 * Declining an already-upcoming reservation (withdraw) removes that row.
 * Anything else leaves the feed untouched.
 */
export function applyResponseToHome(
  home: HomeFeed,
  reservationId: string,
  memberId: string,
  response: ParticipantResponse,
): HomeFeed {
  const invitation = home.pendingInvitations.find((row) => row.id === reservationId);
  if (invitation) {
    const pendingInvitations = home.pendingInvitations.filter((row) => row.id !== reservationId);
    if (response === 'decline') return { ...home, pendingInvitations };
    const upcomingReservations = [
      ...home.upcomingReservations,
      applyResponseToDetail(invitation, memberId, response),
    ].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return { ...home, pendingInvitations, upcomingReservations };
  }
  if (response === 'decline' && home.upcomingReservations.some((row) => row.id === reservationId)) {
    return {
      ...home,
      upcomingReservations: home.upcomingReservations.filter((row) => row.id !== reservationId),
    };
  }
  return home;
}

export function useRespondToReservation() {
  const queryClient = useQueryClient();
  const { memberId } = useSession();

  return useMutation({
    mutationFn: ({ reservationId, response }: RespondInput) =>
      api.respondReservation(reservationId, response),
    onMutate: async ({ reservationId, response }) => {
      const detailKey = ['reservations', reservationId];
      await queryClient.cancelQueries({ queryKey: detailKey });
      await queryClient.cancelQueries({ queryKey: ['home'] });
      const previous = queryClient.getQueryData<ReservationDetail>(detailKey);
      const previousHome = queryClient.getQueriesData<HomeFeed>({ queryKey: ['home'] });
      if (memberId) {
        if (previous) {
          queryClient.setQueryData(detailKey, applyResponseToDetail(previous, memberId, response));
        }
        queryClient.setQueriesData<HomeFeed>({ queryKey: ['home'] }, (home) =>
          home ? applyResponseToHome(home, reservationId, memberId, response) : home,
        );
      }
      return { previous, previousHome };
    },
    onError: (error, { reservationId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['reservations', reservationId], context.previous);
      }
      for (const [key, data] of context?.previousHome ?? []) {
        queryClient.setQueryData(key, data);
      }
      if (isRespondConflict(error)) {
        // The reservation changed under us (cancelled, expired, invite
        // revoked): drop the stale cache and show the truth.
        void queryClient.invalidateQueries({ queryKey: ['reservations', reservationId] });
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });
}
