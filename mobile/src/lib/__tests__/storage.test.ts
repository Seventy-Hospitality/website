import { clearStoredSession, getStoredSession, setStoredSession } from '../storage';

describe('session storage', () => {
  beforeEach(async () => {
    await clearStoredSession();
  });

  it('returns null when nothing is stored', async () => {
    expect(await getStoredSession()).toBeNull();
  });

  it('round-trips the token pair + expiry', async () => {
    await setStoredSession({
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    expect(await getStoredSession()).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('clears every key on sign out', async () => {
    await setStoredSession({
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresAt: 'e',
    });
    await clearStoredSession();
    expect(await getStoredSession()).toBeNull();
  });

  it('treats a missing refresh token as no session', async () => {
    await setStoredSession({
      accessToken: 'only-access',
      refreshToken: '',
      accessTokenExpiresAt: 'e',
    });
    // An empty refresh token means the pair is unusable.
    expect(await getStoredSession()).toBeNull();
  });
});
