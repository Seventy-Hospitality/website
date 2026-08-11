import {
  SESSION_POLICIES,
  isSessionActive,
  sessionExpiries,
  extendedIdleExpiry,
  isWithinRotationGrace,
  REFRESH_ROTATION_GRACE_MS,
} from './session-policy';

const NOW = new Date('2026-08-10T12:00:00Z');

function session(overrides: Partial<Parameters<typeof isSessionActive>[0]> = {}) {
  return {
    revokedAt: null,
    idleExpiresAt: new Date(NOW.getTime() + 60_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  };
}

describe('SESSION_POLICIES', () => {
  it('gives admin web 12h idle / 30d absolute / 5 sessions', () => {
    expect(SESSION_POLICIES.admin_web).toEqual({
      idleTtlMs: 12 * 60 * 60 * 1000,
      absoluteTtlMs: 30 * 24 * 60 * 60 * 1000,
      maxSessions: 5,
    });
  });

  it('gives member web 14d idle / 90d absolute / 10 sessions', () => {
    expect(SESSION_POLICIES.member_web).toEqual({
      idleTtlMs: 14 * 24 * 60 * 60 * 1000,
      absoluteTtlMs: 90 * 24 * 60 * 60 * 1000,
      maxSessions: 10,
    });
  });

  it('gives member mobile 60d idle / 180d absolute / 10 sessions', () => {
    expect(SESSION_POLICIES.member_mobile).toEqual({
      idleTtlMs: 60 * 24 * 60 * 60 * 1000,
      absoluteTtlMs: 180 * 24 * 60 * 60 * 1000,
      maxSessions: 10,
    });
  });
});

describe('isSessionActive', () => {
  it('is active when unrevoked and unexpired', () => {
    expect(isSessionActive(session(), NOW)).toBe(true);
  });

  it('is inactive when revoked', () => {
    expect(isSessionActive(session({ revokedAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(false);
  });

  it('is inactive past the idle expiry', () => {
    expect(isSessionActive(session({ idleExpiresAt: NOW }), NOW)).toBe(false);
  });

  it('is inactive past the absolute expiry', () => {
    expect(isSessionActive(session({ absoluteExpiresAt: NOW }), NOW)).toBe(false);
  });
});

describe('sessionExpiries', () => {
  it('derives both expiries from the client policy', () => {
    const { idleExpiresAt, absoluteExpiresAt } = sessionExpiries('admin_web', NOW);
    expect(idleExpiresAt.getTime()).toBe(NOW.getTime() + 12 * 60 * 60 * 1000);
    expect(absoluteExpiresAt.getTime()).toBe(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  });
});

describe('extendedIdleExpiry', () => {
  it('slides the idle window forward on rotation', () => {
    const absolute = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
    const extended = extendedIdleExpiry('admin_web', absolute, NOW);
    expect(extended.getTime()).toBe(NOW.getTime() + 12 * 60 * 60 * 1000);
  });

  it('never slides past the absolute expiry', () => {
    const absolute = new Date(NOW.getTime() + 60_000);
    const extended = extendedIdleExpiry('admin_web', absolute, NOW);
    expect(extended.getTime()).toBe(absolute.getTime());
  });
});

describe('isWithinRotationGrace', () => {
  it('is false when never rotated', () => {
    expect(isWithinRotationGrace(null, NOW)).toBe(false);
  });

  it('is true just inside the grace window', () => {
    const rotatedAt = new Date(NOW.getTime() - REFRESH_ROTATION_GRACE_MS + 1000);
    expect(isWithinRotationGrace(rotatedAt, NOW)).toBe(true);
  });

  it('is false just outside the grace window', () => {
    const rotatedAt = new Date(NOW.getTime() - REFRESH_ROTATION_GRACE_MS - 1000);
    expect(isWithinRotationGrace(rotatedAt, NOW)).toBe(false);
  });
});
