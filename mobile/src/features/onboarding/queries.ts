/**
 * Shared react-query definitions for the onboarding flow (package M1).
 * Centralized so the gate and the step screens read the same keys and later
 * flows can invalidate by prefix (['onboarding'] / ['membership'] after
 * billing changes, ['id-verification'] after account actions).
 */
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** Public plan catalog; changes rarely, so cache it for the session. */
export const plansQuery = queryOptions({
  queryKey: ['plans'],
  queryFn: api.getPlans,
  staleTime: 5 * 60_000,
});

/**
 * The onboarding-resume read (GET /api/me/onboarding): one call returning the
 * membership + ID-verification facts the step resolver needs. The gate drives
 * off this key; mutations that change the step invalidate it.
 */
export const onboardingQuery = queryOptions({
  queryKey: ['onboarding'],
  queryFn: api.getOnboarding,
});

/**
 * Full government-ID verification view (status + hasPhoto), used by the
 * verify-identity screen. GET /api/me/onboarding carries only the subset the
 * resolver needs, so the screen reads this for hasPhoto / review notes.
 */
export const idVerificationQuery = queryOptions({
  queryKey: ['id-verification'],
  queryFn: api.getIdVerification,
});

/**
 * Billing overview, read ONLY to recover the plan behind an already-created
 * incomplete subscription when checkout is resumed without a ?plan param.
 */
export const billingQuery = queryOptions({
  queryKey: ['billing'],
  queryFn: api.getBilling,
});
