/**
 * Shared react-query definitions for the onboarding flow (package W1).
 * Centralized so the gate and the step pages read the same keys and later
 * flows can invalidate by prefix (['membership'] after billing changes,
 * ['id-verification'] after account actions).
 */
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** Public plan catalog; changes rarely, so cache it for the session. */
export const plansQuery = queryOptions({
  queryKey: ['plans'],
  queryFn: api.getPlans,
  staleTime: 5 * 60_000,
});

/** The member's current membership (requires a member profile). */
export const membershipQuery = queryOptions({
  queryKey: ['membership'],
  queryFn: api.getMyMembership,
});

/** Government-ID verification status (requires a member profile). */
export const idVerificationQuery = queryOptions({
  queryKey: ['id-verification'],
  queryFn: api.getIdVerification,
});
