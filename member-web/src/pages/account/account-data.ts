/**
 * Shared react-query definitions for the account flow (package W6).
 *
 * The billing overview itself rides W1's ['membership'] query
 * (onboarding-data.ts): GET /api/me/billing is one endpoint serving both
 * the onboarding gate (membership status) and the billing page (payment
 * methods, ledger months), so there is deliberately NO separate ['billing']
 * overview key. Mutations that change money state invalidate ['membership']
 * plus the ['billing'] transaction prefix below.
 */
import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** GET /api/me/profile: member, avatar, lifetime stats. */
export const profileQuery = queryOptions({
  queryKey: ['profile'],
  queryFn: api.getMyProfile,
});

/** GET /api/me/preferences: the notification toggles. */
export const preferencesQuery = queryOptions({
  queryKey: ['preferences'],
  queryFn: api.getPreferences,
});

/** GET /api/me/auth-identities: which step-up proof the account can give. */
export const authIdentitiesQuery = queryOptions({
  queryKey: ['auth-identities'],
  queryFn: api.getAuthIdentities,
});

/** One expanded month of ledger rows, fetched lazily on first expand. */
export const billingTransactionsQuery = (month: string) =>
  queryOptions({
    queryKey: ['billing', 'transactions', month],
    queryFn: () => api.getBillingTransactions(month),
    staleTime: 60_000,
  });
