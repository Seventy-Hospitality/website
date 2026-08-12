/**
 * React-query definitions for the mobile reservations surface (M4). The
 * detail read shares the ['reservations', id] key with the booking wizard's
 * cache-write and M2 home's optimistic writes, so respond / reschedule /
 * cancel all converge by invalidating the ['reservations'] prefix.
 */
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** One reservation's detail + viewer capabilities. */
export function reservationQuery(id: string) {
  return queryOptions({
    queryKey: ['reservations', id],
    queryFn: () => api.getReservation(id),
    staleTime: 15_000,
  });
}
