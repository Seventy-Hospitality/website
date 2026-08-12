import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Shared react-query client. Conventions (see CONVENTIONS.md):
 * - queries retry once, but never on 4xx responses (they will not heal);
 * - 30s staleTime keeps tab-switching cheap without going stale;
 * - no refetch-on-focus by default; opt in per query where freshness matters.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 1;
      },
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
    },
  },
});
