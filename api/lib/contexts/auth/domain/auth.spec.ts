import {
  generateToken,
  hashToken,
  isSessionExpired,
  isSessionIdle,
  isSessionValid,
  isMagicLinkExpired,
  isMagicLinkUsed,
  AUTH_CONSTANTS,
} from './auth';
import type { Session, MagicLinkToken } from './auth';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ses_1',
    userId: 'usr_1',
    email: 'test@example.com',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    lastActiveAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeMagicLink(overrides: Partial<MagicLinkToken> = {}): MagicLinkToken {
  return {
    id: 'ml_1',
    email: 'test@example.com',
    tokenHash: 'abc123',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('generateToken', () => {
  it('returns a token and its hash', () => {
    const { token, hash } = generateToken();
    expect(token).toHaveLength(64); // 32 bytes hex
    expect(hash).toHaveLength(64); // sha256 hex
    expect(hash).toBe(hashToken(token));
  });

  it('generates unique tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.token).not.toBe(b.token);
  });
});

describe('hashToken', () => {
  it('is deterministic', () => {
    expect(hashToken('test')).toBe(hashToken('test'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('session validation', () => {
  describe('isSessionExpired', () => {
    it('returns false for future expiry', () => {
      expect(isSessionExpired(makeSession())).toBe(false);
    });

    it('returns true for past expiry', () => {
      expect(
        isSessionExpired(makeSession({ expiresAt: new Date(Date.now() - 1000) }))
      ).toBe(true);
    });
  });

  describe('isSessionIdle', () => {
    it('returns false for recently active session', () => {
      expect(isSessionIdle(makeSession())).toBe(false);
    });

    it('returns true when idle timeout exceeded', () => {
      const pastIdle = new Date(
        Date.now() - (AUTH_CONSTANTS.SESSION_IDLE_TIMEOUT_MINUTES + 1) * 60 * 1000
      );
      expect(isSessionIdle(makeSession({ lastActiveAt: pastIdle }))).toBe(true);
    });
  });

  describe('isSessionValid', () => {
    it('returns true for valid session', () => {
      expect(isSessionValid(makeSession())).toBe(true);
    });

    it('returns false for expired session', () => {
      expect(
        isSessionValid(makeSession({ expiresAt: new Date(Date.now() - 1000) }))
      ).toBe(false);
    });

    it('returns false for idle session', () => {
      const pastIdle = new Date(
        Date.now() - (AUTH_CONSTANTS.SESSION_IDLE_TIMEOUT_MINUTES + 1) * 60 * 1000
      );
      expect(isSessionValid(makeSession({ lastActiveAt: pastIdle }))).toBe(false);
    });
  });
});

describe('magic link validation', () => {
  it('isMagicLinkExpired returns false for valid token', () => {
    expect(isMagicLinkExpired(makeMagicLink())).toBe(false);
  });

  it('isMagicLinkExpired returns true for expired token', () => {
    expect(
      isMagicLinkExpired(makeMagicLink({ expiresAt: new Date(Date.now() - 1000) }))
    ).toBe(true);
  });

  it('isMagicLinkUsed returns false for unused token', () => {
    expect(isMagicLinkUsed(makeMagicLink())).toBe(false);
  });

  it('isMagicLinkUsed returns true for used token', () => {
    expect(isMagicLinkUsed(makeMagicLink({ usedAt: new Date() }))).toBe(true);
  });
});
