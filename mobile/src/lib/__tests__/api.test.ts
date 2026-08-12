import {
  api,
  ApiError,
  request,
  setAuthBridge,
  type AuthBridge,
  type SessionTokens,
} from '../api';

interface FakeInit {
  method?: string;
  headers?: Headers;
  body?: unknown;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const NEW_TOKENS: SessionTokens = {
  accessToken: 'access-2',
  accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
  refreshToken: 'refresh-2',
  refreshTokenExpiresAt: '2030-02-01T00:00:00.000Z',
};

function makeBridge(overrides: Partial<AuthBridge> = {}): AuthBridge {
  return {
    getAccessToken: () => 'access-1',
    getRefreshToken: () => 'refresh-1',
    onTokensRefreshed: jest.fn(),
    onSessionInvalid: jest.fn(),
    ...overrides,
  };
}

afterEach(() => {
  setAuthBridge(null);
  jest.restoreAllMocks();
});

describe('request pipeline', () => {
  it('maps a non-ok envelope to ApiError with code + status', async () => {
    setAuthBridge(makeBridge());
    global.fetch = jest.fn(async () =>
      jsonResponse(400, { error: { code: 'VALIDATION_ERROR', message: 'Bad input' } }),
    ) as unknown as typeof fetch;

    await expect(request('/api/me/home')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'VALIDATION_ERROR',
      status: 400,
      message: 'Bad input',
    });
    await expect(request('/api/me/home')).rejects.toBeInstanceOf(ApiError);
  });

  it('sends the bearer token and X-Client-Type: mobile on auth calls', async () => {
    setAuthBridge(makeBridge({ getAccessToken: () => 'access-xyz' }));
    const calls: { url: string; init: FakeInit }[] = [];
    global.fetch = jest.fn(async (url: string, init: FakeInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { data: { user: {}, accessToken: 'a', refreshToken: 'r' } });
    }) as unknown as typeof fetch;

    await api.signIn({ email: 'a@b.com', password: 'secret' });

    const { url, init } = calls[0];
    expect(url).toContain('/api/auth/signin');
    expect(init.headers?.get('Authorization')).toBe('Bearer access-xyz');
    expect(init.headers?.get('X-Client-Type')).toBe('mobile');
    expect(init.headers?.get('Content-Type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ email: 'a@b.com', password: 'secret' }));
  });

  it('refreshes once for concurrent 401s and retries both (single-flight)', async () => {
    const onTokensRefreshed = jest.fn();
    setAuthBridge(makeBridge({ onTokensRefreshed }));

    let refreshCount = 0;
    let refreshed = false;
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        refreshCount += 1;
        refreshed = true;
        return jsonResponse(200, { data: NEW_TOKENS });
      }
      if (!refreshed) {
        return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } });
      }
      return jsonResponse(200, { data: { ok: true } });
    }) as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      request<{ ok: boolean }>('/api/me/home'),
      request<{ ok: boolean }>('/api/me/profile'),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(refreshCount).toBe(1);
    expect(onTokensRefreshed).toHaveBeenCalledTimes(1);
    expect(onTokensRefreshed).toHaveBeenCalledWith(NEW_TOKENS);
  });

  it('invalidates the session when the refresh is definitively rejected (401)', async () => {
    const onSessionInvalid = jest.fn();
    setAuthBridge(makeBridge({ onSessionInvalid }));

    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        return jsonResponse(401, { error: { code: 'INVALID_TOKEN', message: 'dead' } });
      }
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } });
    }) as unknown as typeof fetch;

    await expect(request('/api/me/home')).rejects.toMatchObject({ status: 401 });
    expect(onSessionInvalid).toHaveBeenCalledTimes(1);
  });

  it('KEEPS the session when the refresh fails transiently (5xx)', async () => {
    // A momentary backend/DB blip on /refresh must not force a full re-login.
    const onSessionInvalid = jest.fn();
    setAuthBridge(makeBridge({ onSessionInvalid }));

    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        return jsonResponse(500, { error: { code: 'INTERNAL', message: 'boom' } });
      }
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } });
    }) as unknown as typeof fetch;

    await expect(request('/api/me/home')).rejects.toMatchObject({
      code: 'SESSION_REFRESH_UNAVAILABLE',
      status: 503,
    });
    expect(onSessionInvalid).not.toHaveBeenCalled();
  });

  it('KEEPS the session when the refresh request throws (network error)', async () => {
    // Flaky wifi on the refresh POST is transient, not a dead token.
    const onSessionInvalid = jest.fn();
    setAuthBridge(makeBridge({ onSessionInvalid }));

    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        throw new TypeError('Network request failed');
      }
      return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } });
    }) as unknown as typeof fetch;

    await expect(request('/api/me/home')).rejects.toMatchObject({
      code: 'SESSION_REFRESH_UNAVAILABLE',
    });
    expect(onSessionInvalid).not.toHaveBeenCalled();
  });

  it('signs out when the refresh token is missing entirely', async () => {
    const onSessionInvalid = jest.fn();
    setAuthBridge(makeBridge({ getRefreshToken: () => null, onSessionInvalid }));

    global.fetch = jest.fn(async () =>
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }),
    ) as unknown as typeof fetch;

    await expect(request('/api/me/home')).rejects.toMatchObject({ status: 401 });
    expect(onSessionInvalid).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a refresh on a 401 from an auth path', async () => {
    setAuthBridge(makeBridge());
    let refreshCount = 0;
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) refreshCount += 1;
      return jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'no' } });
    }) as unknown as typeof fetch;

    await expect(api.signIn({ email: 'a@b.com', password: 'x' })).rejects.toMatchObject({
      status: 401,
    });
    expect(refreshCount).toBe(0);
  });
});
