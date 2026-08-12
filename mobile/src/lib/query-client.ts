import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Shared react-query client, mirroring member-web's conventions:
 * - queries retry once, but never on a 4xx (it will not heal);
 * - 30s staleTime keeps tab-switching cheap without going stale;
 * - no refetch-on-focus by default; opt in per query where freshness matters.
 *
 * Flow packages read/write server state exclusively through this client and
 * the typed `api` in ./api; no ad hoc fetch in components.
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
