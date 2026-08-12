/**
 * Home feed data (package W2). Query key ['home'] is the invalidation
 * target every reservation-changing mutation already uses (booking
 * checkout, respond, cancel, reschedule; see CONVENTIONS.md), so the feed
 * converges after any of them.
 */
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type ClubInvitation, type HomeFeed } from '../../lib/api';

/**
 * The browser's IANA zone for the greeting ("Good evening" in the
 * member's clock, not the venue's). Undefined when the runtime cannot
 * say; the backend then falls back to the venue zone.
 */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export const homeQuery = queryOptions({
  queryKey: ['home'],
  queryFn: () => api.getHome(browserTimeZone()),
  staleTime: 30_000,
  // The feed is the app's front door; catch changes made elsewhere
  // (mobile, another tab) when the member comes back to it.
  refetchOnWindowFocus: true,
});

export interface ClubInvitationRespondInput {
  invitationId: string;
  response: 'accept' | 'decline';
}

/** Error codes meaning "this club invitation already moved on". */
export function isClubInviteConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'INVALID_INVITATION_STATE' || error.code === 'NOT_FOUND')
  );
}

/**
 * Accept/decline a club invitation (POST /api/club-invitations/:id/respond)
 * with the same cache discipline as the reservation respond hook: the card
 * leaves the ['home'] feed AND the ['club-invitations'] list (the clubs
 * tab renders the same invitations, W5) optimistically with snapshot
 * rollback, conflicts re-fetch the truth, and settlement invalidates
 * ['home'], ['club-invitations'], and the ['clubs'] prefix (accepting adds
 * a club to the member's list).
 */
export function useRespondToClubInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ invitationId, response }: ClubInvitationRespondInput) =>
      api.respondToClubInvitation(invitationId, response),
    onMutate: async ({ invitationId }) => {
      await queryClient.cancelQueries({ queryKey: ['home'] });
      await queryClient.cancelQueries({ queryKey: ['club-invitations'] });
      const previousHome = queryClient.getQueriesData<HomeFeed>({ queryKey: ['home'] });
      const previousInvitations = queryClient.getQueriesData<ClubInvitation[]>({
        queryKey: ['club-invitations'],
      });
      queryClient.setQueriesData<HomeFeed>({ queryKey: ['home'] }, (home) =>
        home
          ? {
              ...home,
              clubInvitations: home.clubInvitations.filter((row) => row.id !== invitationId),
            }
          : home,
      );
      queryClient.setQueriesData<ClubInvitation[]>({ queryKey: ['club-invitations'] }, (rows) =>
        rows?.filter((row) => row.id !== invitationId),
      );
      return { previousHome, previousInvitations };
    },
    onError: (error, _input, context) => {
      for (const [key, data] of context?.previousHome ?? []) {
        queryClient.setQueryData(key, data);
      }
      for (const [key, data] of context?.previousInvitations ?? []) {
        queryClient.setQueryData(key, data);
      }
      if (isClubInviteConflict(error)) {
        void queryClient.invalidateQueries({ queryKey: ['home'] });
        void queryClient.invalidateQueries({ queryKey: ['club-invitations'] });
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      void queryClient.invalidateQueries({ queryKey: ['club-invitations'] });
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
    },
  });
}
