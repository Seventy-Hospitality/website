/**
 * The shared invitation-response mutation (POST /api/reservations/:id/
 * respond). W4's detail page and W2's home cards render the same
 * ACCEPT / DECLINE actions, so the cache discipline lives here once:
 *
 * - optimistic: the viewer's row in the ['reservations', id] detail cache
 *   (participants + myParticipation + viewer.status) flips immediately,
 *   with a snapshot rollback on error;
 * - conflicts (the reservation was cancelled/expired mid-flight, or the
 *   invite was revoked) re-fetch the truth instead of trusting the cache;
 * - settlement invalidates the ['reservations'] and ['home'] prefixes so
 *   every surface converges on the server state.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Reservation, type ReservationViewer } from './api';
import { useSession } from './session-context';
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

export function useRespondToReservation() {
  const queryClient = useQueryClient();
  const { memberId } = useSession();

  return useMutation({
    mutationFn: ({ reservationId, response }: RespondInput) =>
      api.respondToReservation(reservationId, response),
    onMutate: async ({ reservationId, response }) => {
      const detailKey = ['reservations', reservationId];
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData<ReservationDetail>(detailKey);
      if (previous && memberId) {
        queryClient.setQueryData(detailKey, applyResponseToDetail(previous, memberId, response));
      }
      return { previous };
    },
    onError: (error, { reservationId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['reservations', reservationId], context.previous);
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
