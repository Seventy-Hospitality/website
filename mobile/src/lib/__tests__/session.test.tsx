import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { SessionProvider, useSession } from '../session';
import { createPendingMagicLinkState, consumePendingMagicLinkState } from '../magic-link';
import { clearStoredSession } from '../storage';

function wrapper({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const PRINCIPAL = {
  userId: 'user-1',
  email: 'alice@example.com',
  emailVerified: true,
  staffRole: null,
  memberId: 'member-1',
  client: 'member_mobile',
};

beforeEach(async () => {
  // No stored session and no pending magic-link request at the start of a test.
  await clearStoredSession();
  await consumePendingMagicLinkState('');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('completeMagicLink state binding (forced-login defense)', () => {
  it('rejects an injected callback with no pending request and establishes nothing', async () => {
    // Fetch must never be reached: the tokens are rejected before /me.
    global.fetch = jest.fn() as unknown as typeof fetch;

    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));

    await expect(
      result.current.completeMagicLink({
        accessToken: 'attacker-access',
        refreshToken: 'attacker-refresh',
        accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
        state: 'never-issued-on-this-device',
      }),
    ).rejects.toThrow();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.current.status).toBe('anonymous');
    expect(result.current.principal).toBeNull();
  });

  it('establishes the session when the callback state matches the pending request', async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).endsWith('/api/auth/me')) return jsonResponse(200, { data: PRINCIPAL });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    // Simulate the request leg minting + persisting the pending state.
    const state = await createPendingMagicLinkState();

    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));

    let principal: unknown;
    await act(async () => {
      principal = await result.current.completeMagicLink({
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
        state,
      });
    });

    expect(principal).toMatchObject({ userId: 'user-1' });
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(result.current.principal).toMatchObject({ userId: 'user-1' });
  });

  it('is single-use: the same state cannot be replayed after a success', async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).endsWith('/api/auth/me')) return jsonResponse(200, { data: PRINCIPAL });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const state = await createPendingMagicLinkState();
    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));

    await act(async () => {
      await result.current.completeMagicLink({
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
        state,
      });
    });

    await expect(
      result.current.completeMagicLink({
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
        state,
      }),
    ).rejects.toThrow();
  });
});
