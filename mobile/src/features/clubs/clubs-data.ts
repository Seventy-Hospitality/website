/**
 * React-query definitions and the invite-link hook for the mobile clubs
 * surface (M5). Query keys mirror member-web so every club-changing mutation
 * converges by invalidating a shared prefix:
 *   ['clubs']                          the member's club list (defined in M3)
 *   ['clubs', id]                      one club's detail + permission flags
 *   ['clubs', id, 'members']           the roster
 *   ['clubs', id, 'activity']          the group-activity feed
 *   ['clubs', id, 'invite-link']       cache-only holder for the minted share URL
 *   ['club-invitations']               the viewer's pending club invitations
 *   ['clubs', 'invite-preview', token] a join-link preview
 *   ['members', 'directory', q]        the club invite picker's directory feed
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { WEB_URL } from '../../lib/env';
import { clubJoinUrl } from './clubs-lib';

// The club list already lives on ['clubs'] in M3's booking-data; re-export it
// so the clubs tab and M3 share one cache entry (and one invalidation target).
export { myClubsQuery } from '../reserve/booking-data';

/** One club's detail + the viewer's permission flags. */
export function clubQuery(clubId: string) {
  return queryOptions({
    queryKey: ['clubs', clubId],
    queryFn: () => api.getClub(clubId),
    staleTime: 30_000,
  });
}

/** A club's roster (owner-first, then by tenure). */
export function clubMembersQuery(clubId: string) {
  return queryOptions({
    queryKey: ['clubs', clubId, 'members'],
    queryFn: () => api.getClubMembers(clubId),
    staleTime: 30_000,
  });
}

/** A club's group-activity feed (all club-linked reservations). */
export function clubActivityQuery(clubId: string) {
  return queryOptions({
    queryKey: ['clubs', clubId, 'activity'],
    queryFn: () => api.getClubActivity(clubId, 'all'),
    staleTime: 30_000,
  });
}

/** The viewer's pending club invitations (also rendered on the clubs tab). */
export const clubInvitationsQuery = queryOptions({
  queryKey: ['club-invitations'],
  queryFn: api.getMyClubInvitations,
  staleTime: 30_000,
});

/**
 * A join-link preview. Always fresh (a link can die between opening the screen
 * and joining) and never retried (a 410 is terminal, not a transient blip).
 */
export function clubInvitePreviewQuery(token: string) {
  return queryOptions({
    queryKey: ['clubs', 'invite-preview', token],
    queryFn: () => api.previewClubInvite(token),
    staleTime: 0,
    retry: false,
  });
}

/**
 * The invite picker's directory feed: an empty query returns an alphabetical
 * directory page (the server excludes the caller); a non-empty query searches.
 * A 25-row limit and its own ['members','directory'] key keep it from
 * clobbering M3's booking search (['members','search'], limit 10).
 */
export function clubDirectoryQuery(q: string) {
  return queryOptions({
    queryKey: ['members', 'directory', q],
    queryFn: () => api.searchMembers(q, 25),
    staleTime: 30_000,
  });
}

export interface ClubInviteLinkController {
  /** The current share URL, or null until minted. */
  url: string | null;
  /** A mint or rotate is in flight (disable the copy/QR/share actions). */
  isPending: boolean;
  /** Return the cached URL, minting one on first use (single-flighted). */
  ensureUrl: () => Promise<string>;
  /** Rotate the link (owner-only): revokes every prior link, caches the new URL. */
  reset: () => Promise<string>;
}

/**
 * The club's shareable invite URL, held in the query cache at
 * ['clubs', id, 'invite-link'] so every surface that shares the club (the
 * detail Share action and the invite sheet) reads the same URL, and a rotate
 * swaps it everywhere at once. The query never fetches (enabled:false); it only
 * subscribes the component so a setQueryData write re-renders it. The raw token
 * leaves the API once at mint, so we build and cache the URL immediately.
 */
export function useClubInviteLink(clubId: string): ClubInviteLinkController {
  const queryClient = useQueryClient();
  const key = useMemo(() => ['clubs', clubId, 'invite-link'] as const, [clubId]);
  const [isPending, setIsPending] = useState(false);
  const inFlight = useRef<Promise<string> | null>(null);

  // Subscribe to the cache slot without ever fetching; setQueryData re-renders.
  const cached = useQuery({
    queryKey: key,
    queryFn: () => queryClient.getQueryData<string>(key) ?? null,
    enabled: false,
    staleTime: Infinity,
  });
  const url = cached.data ?? null;

  const ensureUrl = useCallback(async () => {
    const existing = queryClient.getQueryData<string>(key);
    if (existing) return existing;
    if (inFlight.current) return inFlight.current;
    setIsPending(true);
    const request = (async () => {
      const link = await api.createClubInviteLink(clubId, {});
      // A rotate that landed while we were minting wins (it revoked this one).
      const rotated = queryClient.getQueryData<string>(key);
      if (rotated) return rotated;
      const built = clubJoinUrl(link.token, WEB_URL);
      queryClient.setQueryData(key, built);
      return built;
    })();
    inFlight.current = request;
    try {
      return await request;
    } finally {
      inFlight.current = null;
      setIsPending(false);
    }
  }, [clubId, key, queryClient]);

  const reset = useCallback(async () => {
    setIsPending(true);
    try {
      const link = await api.createClubInviteLink(clubId, { rotate: true });
      const built = clubJoinUrl(link.token, WEB_URL);
      queryClient.setQueryData(key, built);
      return built;
    } finally {
      setIsPending(false);
    }
  }, [clubId, key, queryClient]);

  return { url, isPending, ensureUrl, reset };
}
