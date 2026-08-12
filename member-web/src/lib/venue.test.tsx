import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api, type VenueInfo } from './api';
import { browserTimezone, useVenueTimezone, venueQuery } from './venue';

/**
 * The venue-timezone hook: venue zone once loaded, browser zone as the
 * only fallback (loading, failure, unformattable zone), never blocking.
 */

vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  return {
    ...original,
    api: { ...original.api, getVenue: vi.fn() },
  };
});

const getVenue = vi.mocked(api.getVenue);

function renderVenueTimezone() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = renderHook(() => useVenueTimezone(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  return { ...rendered, queryClient };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useVenueTimezone', () => {
  it('answers with the browser zone while loading, then the venue zone', async () => {
    let resolveVenue!: (value: VenueInfo) => void;
    getVenue.mockImplementation(() => new Promise<VenueInfo>((resolve) => (resolveVenue = resolve)));

    const { result } = renderVenueTimezone();

    // Loading: the fallback keeps date math working immediately.
    expect(result.current).toBe(browserTimezone());

    resolveVenue({ timezone: 'America/New_York' });
    await waitFor(() => expect(result.current).toBe('America/New_York'));
  });

  it('falls back to the browser zone when the request fails', async () => {
    getVenue.mockRejectedValue(new Error('boom'));

    const { result, queryClient } = renderVenueTimezone();

    await waitFor(() =>
      expect(queryClient.getQueryState(venueQuery.queryKey)?.status).toBe('error'),
    );
    expect(result.current).toBe(browserTimezone());
  });

  it('ignores a zone this browser cannot format with', async () => {
    getVenue.mockResolvedValue({ timezone: 'Not/AZone' });

    const { result, queryClient } = renderVenueTimezone();

    await waitFor(() =>
      expect(queryClient.getQueryState(venueQuery.queryKey)?.status).toBe('success'),
    );
    expect(result.current).toBe(browserTimezone());
  });
});
