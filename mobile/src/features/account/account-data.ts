/**
 * React-query definitions for the mobile account surface (M6). Keys mirror the
 * mobile precedent set by M0..M5 so every account-changing mutation converges
 * by invalidating a shared key:
 *   ['profile']                       profile + lifetime stats (avatar, name)
 *   ['billing']                       the BillingOverview (membership + cards + months)
 *   ['billing','transactions',month]  one month's ledger rows (lazy, on expand)
 *   ['preferences']                   notification toggles
 *   ['auth-identities']               password + linked Google/Apple providers
 *   ['plans']                         the public plan catalog (shared with M1)
 *   ['member-qr']                     the check-in token (owned by MemberCardSheet)
 *
 * NOTE on the billing key: member-web keys the billing overview ['membership'];
 * mobile keys it ['billing'] because M1's onboarding checkout already
 * established that key for GET /api/me/billing. We invalidate BOTH after money
 * mutations so either convention converges.
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** Profile + plan catalog + lifetime stats (GET /api/me/profile). */
export const profileQuery = queryOptions({
  queryKey: ['profile'],
  queryFn: api.getProfile,
  staleTime: 30_000,
});

/**
 * The billing overview (GET /api/me/billing): membership, default payment
 * method, saved cards, and ledger months. The single source for the current
 * membership across account (M1 onboarding reads only its `.membership`).
 */
export const billingQuery = queryOptions({
  queryKey: ['billing'],
  queryFn: api.getBilling,
  staleTime: 15_000,
});

/** Notification preferences (GET /api/me/preferences). */
export const preferencesQuery = queryOptions({
  queryKey: ['preferences'],
  queryFn: api.getPreferences,
  staleTime: 30_000,
});

/** Password + linked OAuth providers (GET /api/me/auth-identities). */
export const authIdentitiesQuery = queryOptions({
  queryKey: ['auth-identities'],
  queryFn: api.getAuthIdentities,
  staleTime: 30_000,
});

/**
 * One month's transactions, fetched lazily the first time a billing-history
 * month is expanded and kept afterwards. Shares the ['billing'] prefix so a
 * money mutation's prefix-invalidation refreshes any opened month too.
 */
export function billingTransactionsQuery(month: string) {
  return queryOptions({
    queryKey: ['billing', 'transactions', month],
    queryFn: () => api.getBillingTransactions(month),
    staleTime: 60_000,
  });
}

/**
 * Converge every surface that reflects a membership / payment change. Mirrors
 * member-web's invalidateBillingState (['membership'] there) across the mobile
 * key set: billing overview + its lazy month children (['billing'] prefix),
 * the historical ['membership'] alias, the profile card, the home feed, and the
 * onboarding-resume read.
 */
export function invalidateBillingState(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['billing'] });
  void queryClient.invalidateQueries({ queryKey: ['membership'] });
  void queryClient.invalidateQueries({ queryKey: ['profile'] });
  void queryClient.invalidateQueries({ queryKey: ['home'] });
  void queryClient.invalidateQueries({ queryKey: ['onboarding'] });
}
