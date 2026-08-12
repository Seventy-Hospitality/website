/**
 * Clubs data (package W5). Query keys follow the shared convention:
 * ['clubs'] is the member's list (owned by booking-data's myClubsQuery,
 * which W3's invite step already consumes), ['clubs', id] the detail,
 * ['clubs', id, 'members'] the roster (booking-data's clubRosterQuery),
 * ['clubs', id, 'activity'] the feed, ['club-invitations'] the viewer's
 * pending invitations. Mutations invalidate by those prefixes.
 */
import { useRef, useState } from 'react';
import { queryOptions, useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { clubJoinUrl } from './clubs-lib';

export function clubQuery(clubId: string) {
  return queryOptions({
    queryKey: ['clubs', clubId],
    queryFn: () => api.getClub(clubId),
    staleTime: 30_000,
  });
}

export function clubActivityQuery(clubId: string) {
  return queryOptions({
    // The Figma feed mixes upcoming and past in one list, so 'all' is the
    // one variant this client requests (no filter in the key).
    queryKey: ['clubs', clubId, 'activity'],
    queryFn: () => api.getClubActivity(clubId, 'all'),
    staleTime: 30_000,
  });
}

export const myClubInvitationsQuery = queryOptions({
  queryKey: ['club-invitations'],
  queryFn: api.getMyClubInvitations,
  staleTime: 30_000,
});

/**
 * Directory-backed picker feed: an empty query serves the default
 * alphabetical directory page (which excludes the caller server-side); a
 * non-empty one searches by name or member number. Distinct from W3's
 * memberSearchQuery (limit 10) so neither clobbers the other's cache.
 */
export function clubDirectoryQuery(q: string) {
  return queryOptions({
    queryKey: ['members', 'directory', q],
    queryFn: () => api.searchMembers(q, 25),
    staleTime: 30_000,
  });
}

/**
 * Lazily minted share link for one club, held for the component's
 * lifetime: the first Copy/QR/Share action mints a link (POST invite-link)
 * and every later action reuses it. `reset` rotates (owner only): mints a
 * fresh link AND revokes every other active one.
 */
export function useClubInviteLink(clubId: string) {
  const [url, setUrl] = useState<string | null>(null);
  // Single-flight: concurrent ensureUrl calls share one mint request.
  const inFlight = useRef<Promise<string> | null>(null);

  const mint = useMutation({
    mutationFn: (options: { rotate?: boolean } = {}) => api.createClubInviteLink(clubId, options),
  });

  async function ensureUrl(): Promise<string> {
    if (url) return url;
    inFlight.current ??= mint
      .mutateAsync({})
      .then((link) => {
        const next = clubJoinUrl(link.token, window.location.origin);
        setUrl(next);
        return next;
      })
      .finally(() => {
        inFlight.current = null;
      });
    return inFlight.current;
  }

  async function reset(): Promise<string> {
    const link = await mint.mutateAsync({ rotate: true });
    const next = clubJoinUrl(link.token, window.location.origin);
    setUrl(next);
    return next;
  }

  return { url, ensureUrl, reset, isPending: mint.isPending };
}
