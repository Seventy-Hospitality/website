import { SessionService, toAuthenticatedUser } from './session.service';
import { hashToken, REFRESH_ROTATION_GRACE_MS, SessionExpiredError, InvalidTokenError, NotAuthorizedError } from '../domain';
import type { AuthSessionRepository, AuthSessionRecord } from '../infrastructure/auth-session.repository';
import type { UserRepository, IdentityUser } from '../infrastructure/user.repository';
import type { JwtService } from '../infrastructure/jwt.service';
import type { UnitOfWork, TransactionContext } from '@/lib/kernel/unit-of-work';
import type { AuditLog } from './ports';

const FAKE_TX = {} as TransactionContext;

function mockUow(): UnitOfWork {
  return { execute: vi.fn((fn: (tx: TransactionContext) => Promise<unknown>) => fn(FAKE_TX)) } as unknown as UnitOfWork;
}

function user(overrides: Partial<IdentityUser> = {}): IdentityUser {
  return {
    id: 'usr_1',
    email: 'person@example.com',
    name: 'Person Example',
    staffRole: null,
    status: 'active',
    emailVerifiedAt: new Date('2026-08-01T00:00:00Z'),
    termsAcceptedAt: null,
    termsVersion: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<AuthSessionRecord> = {}): AuthSessionRecord {
  return {
    id: 'ses_1',
    userId: 'usr_1',
    client: 'member_mobile',
    refreshTokenHash: 'current_hash',
    previousTokenHash: null,
    rotatedAt: null,
    issuedAt: new Date(Date.now() - 60_000),
    lastUsedAt: new Date(Date.now() - 60_000),
    idleExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    absoluteExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    revokedReason: null,
    deviceName: null,
    ip: null,
    ...overrides,
  };
}

function mockSessionRepo(): AuthSessionRepository {
  return {
    create: vi.fn().mockImplementation(async (input: Record<string, unknown>) => sessionRecord(input as Partial<AuthSessionRecord>)),
    findById: vi.fn(),
    findByRefreshTokenHash: vi.fn().mockResolvedValue(null),
    findByPreviousTokenHash: vi.fn().mockResolvedValue(null),
    rotate: vi.fn().mockResolvedValue(true),
    touch: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    revokeAllForUser: vi.fn().mockResolvedValue(1),
    evictBeyondCap: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthSessionRepository;
}

function mockUserRepo(found: IdentityUser | null = user()): UserRepository {
  return {
    findById: vi.fn().mockResolvedValue(found),
  } as unknown as UserRepository;
}

function mockJwt(): JwtService {
  return {
    signAccessToken: vi.fn().mockResolvedValue({
      token: 'access_jwt',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }),
    verifyAccessToken: vi.fn(),
  } as unknown as JwtService;
}

function mockAudit(): AuditLog {
  return { append: vi.fn().mockResolvedValue({ id: 'evt_1', seq: 1 }) };
}

function createService(overrides: {
  sessionRepo?: AuthSessionRepository;
  userRepo?: UserRepository;
  jwt?: JwtService;
  audit?: AuditLog;
  uow?: UnitOfWork;
} = {}) {
  const deps = {
    sessionRepo: overrides.sessionRepo ?? mockSessionRepo(),
    userRepo: overrides.userRepo ?? mockUserRepo(),
    jwt: overrides.jwt ?? mockJwt(),
    audit: overrides.audit ?? mockAudit(),
    uow: overrides.uow ?? mockUow(),
  };
  return { service: new SessionService(deps.sessionRepo, deps.userRepo, deps.jwt, deps.audit, deps.uow), ...deps };
}

describe('SessionService', () => {
  describe('issue', () => {
    it('evicts beyond the per-client cap before creating the session', async () => {
      const { service, sessionRepo } = createService();
      await service.issue(user(), 'member_mobile');

      expect(sessionRepo.evictBeyondCap).toHaveBeenCalledWith('usr_1', 'member_mobile', 9, FAKE_TX);
      expect(sessionRepo.create).toHaveBeenCalledOnce();
    });

    it('uses the admin web cap of 5', async () => {
      const { service, sessionRepo } = createService();
      await service.issue(user(), 'admin_web');

      expect(sessionRepo.evictBeyondCap).toHaveBeenCalledWith('usr_1', 'admin_web', 4, FAKE_TX);
    });

    it('stores only the hash of the refresh token', async () => {
      const { service, sessionRepo } = createService();
      const issued = await service.issue(user(), 'member_mobile');

      const createInput = (sessionRepo.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createInput.refreshTokenHash).toBe(hashToken(issued.refreshToken));
      expect(createInput.refreshTokenHash).not.toBe(issued.refreshToken);
    });

    it('returns an access token and the idle expiry as refresh lifetime', async () => {
      const { service } = createService();
      const issued = await service.issue(user(), 'admin_web');

      expect(issued.accessToken).toBe('access_jwt');
      expect(issued.refreshTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(issued.client).toBe('admin_web');
    });
  });

  describe('refresh — happy rotation', () => {
    it('rotates the token and slides the idle window', async () => {
      const sessionRepo = mockSessionRepo();
      const record = sessionRecord({ refreshTokenHash: hashToken('raw_refresh') });
      (sessionRepo.findByRefreshTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(record);

      const { service } = createService({ sessionRepo });
      const issued = await service.refresh('raw_refresh');

      const rotateArgs = (sessionRepo.rotate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(rotateArgs[0]).toBe('ses_1');
      expect(rotateArgs[1].expectedCurrentHash).toBe(hashToken('raw_refresh'));
      expect(rotateArgs[1].previousTokenHash).toBe(hashToken('raw_refresh'));
      expect(rotateArgs[1].refreshTokenHash).toBe(hashToken(issued.refreshToken));
      expect(issued.refreshToken).not.toBe('raw_refresh');
    });

    it('rejects an expired session', async () => {
      const sessionRepo = mockSessionRepo();
      (sessionRepo.findByRefreshTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(
        sessionRecord({ idleExpiresAt: new Date(Date.now() - 1000) }),
      );

      const { service } = createService({ sessionRepo });
      await expect(service.refresh('raw_refresh')).rejects.toThrow(SessionExpiredError);
    });

    it('rejects a revoked session', async () => {
      const sessionRepo = mockSessionRepo();
      (sessionRepo.findByRefreshTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(
        sessionRecord({ revokedAt: new Date() }),
      );

      const { service } = createService({ sessionRepo });
      await expect(service.refresh('raw_refresh')).rejects.toThrow(SessionExpiredError);
    });

    it('rejects an unknown token', async () => {
      const { service } = createService();
      await expect(service.refresh('unknown')).rejects.toThrow(InvalidTokenError);
    });

    it('revokes the session and rejects when the account is no longer active', async () => {
      const sessionRepo = mockSessionRepo();
      (sessionRepo.findByRefreshTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(
        sessionRecord({ refreshTokenHash: hashToken('raw_refresh') }),
      );

      const { service } = createService({ sessionRepo, userRepo: mockUserRepo(user({ status: 'suspended' })) });
      await expect(service.refresh('raw_refresh')).rejects.toThrow(NotAuthorizedError);
      expect(sessionRepo.revoke).toHaveBeenCalledWith('ses_1', 'account_unavailable');
    });
  });

  describe('refresh — grace window', () => {
    it('treats a previous-token retry inside the grace window as benign and rotates again', async () => {
      const sessionRepo = mockSessionRepo();
      const rotatedAt = new Date(Date.now() - REFRESH_ROTATION_GRACE_MS / 2);
      const record = sessionRecord({
        refreshTokenHash: 'newer_hash',
        previousTokenHash: hashToken('old_refresh'),
        rotatedAt,
      });
      (sessionRepo.findByPreviousTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(record);

      const { service } = createService({ sessionRepo });
      const issued = await service.refresh('old_refresh');

      const rotateArgs = (sessionRepo.rotate as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(rotateArgs.expectedCurrentHash).toBe('newer_hash');
      expect(rotateArgs.previousTokenHash).toBe(hashToken('old_refresh')); // stays anchored
      expect(rotateArgs.rotatedAt).toEqual(rotatedAt); // grace never slides
      expect(issued.sessionId).toBe('ses_1');
      expect(sessionRepo.revoke).not.toHaveBeenCalled();
    });

    it('revokes the session and audits on reuse outside the grace window', async () => {
      const sessionRepo = mockSessionRepo();
      const audit = mockAudit();
      (sessionRepo.findByPreviousTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(
        sessionRecord({
          refreshTokenHash: 'newer_hash',
          previousTokenHash: hashToken('stolen_refresh'),
          rotatedAt: new Date(Date.now() - REFRESH_ROTATION_GRACE_MS - 5000),
        }),
      );

      const { service } = createService({ sessionRepo, audit });
      await expect(service.refresh('stolen_refresh')).rejects.toThrow(InvalidTokenError);

      expect(sessionRepo.revoke).toHaveBeenCalledWith('ses_1', 'refresh_reuse', FAKE_TX);
      expect(audit.append).toHaveBeenCalledWith(FAKE_TX, expect.objectContaining({
        streamType: 'user',
        streamId: 'usr_1',
        eventType: 'RefreshTokenReuseDetected',
      }));
    });

    it('falls through to the grace path when a concurrent rotation wins the guarded update', async () => {
      const sessionRepo = mockSessionRepo();
      const record = sessionRecord({ refreshTokenHash: hashToken('raw_refresh') });
      (sessionRepo.findByRefreshTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(record);
      // First rotate loses the race; the concurrent winner moved our hash to previousTokenHash.
      (sessionRepo.rotate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      (sessionRepo.findByPreviousTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(
        sessionRecord({
          refreshTokenHash: 'winner_hash',
          previousTokenHash: hashToken('raw_refresh'),
          rotatedAt: new Date(),
        }),
      );

      const { service } = createService({ sessionRepo });
      const issued = await service.refresh('raw_refresh');
      expect(issued.sessionId).toBe('ses_1');
      expect(sessionRepo.rotate).toHaveBeenCalledTimes(2);
    });
  });

  describe('validateAccessToken', () => {
    function withValidToken(overrides: {
      session?: AuthSessionRecord | null;
      user?: IdentityUser | null;
    } = {}) {
      const jwt = mockJwt();
      (jwt.verifyAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        sub: 'usr_1',
        sid: 'ses_1',
        typ: 'access',
      });
      const sessionRepo = mockSessionRepo();
      (sessionRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
        overrides.session === undefined ? sessionRecord() : overrides.session,
      );
      const userRepo = mockUserRepo(overrides.user === undefined ? user({ staffRole: 'admin' }) : overrides.user);
      return createService({ jwt, sessionRepo, userRepo });
    }

    it('returns the authenticated user from a fresh DB read', async () => {
      const { service, sessionRepo } = withValidToken();
      const authenticated = await service.validateAccessToken('access_jwt');

      expect(authenticated).toEqual({
        userId: 'usr_1',
        sessionId: 'ses_1',
        email: 'person@example.com',
        emailVerifiedAt: new Date('2026-08-01T00:00:00Z'),
        staffRole: 'admin',
        client: 'member_mobile',
      });
      expect(sessionRepo.touch).toHaveBeenCalledWith('ses_1');
    });

    it('rejects an invalid JWT', async () => {
      const jwt = mockJwt();
      (jwt.verifyAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const { service } = createService({ jwt });
      await expect(service.validateAccessToken('bad')).rejects.toThrow(SessionExpiredError);
    });

    it('rejects when the session row is gone (instant revocation)', async () => {
      const { service } = withValidToken({ session: null });
      await expect(service.validateAccessToken('access_jwt')).rejects.toThrow(SessionExpiredError);
    });

    it('rejects a revoked session', async () => {
      const { service } = withValidToken({ session: sessionRecord({ revokedAt: new Date() }) });
      await expect(service.validateAccessToken('access_jwt')).rejects.toThrow(SessionExpiredError);
    });

    it('rejects a session belonging to a different user', async () => {
      const { service } = withValidToken({ session: sessionRecord({ userId: 'usr_other' }) });
      await expect(service.validateAccessToken('access_jwt')).rejects.toThrow(SessionExpiredError);
    });

    it('rejects when the user is missing or inactive', async () => {
      const { service } = withValidToken({ user: null });
      await expect(service.validateAccessToken('access_jwt')).rejects.toThrow(NotAuthorizedError);

      const { service: suspended } = withValidToken({ user: user({ status: 'suspended' }) });
      await expect(suspended.validateAccessToken('access_jwt')).rejects.toThrow(NotAuthorizedError);
    });
  });

  describe('revocation', () => {
    it('revokes a single session', async () => {
      const { service, sessionRepo } = createService();
      await service.revoke('ses_1');
      expect(sessionRepo.revoke).toHaveBeenCalledWith('ses_1', 'signout');
    });

    it('revokes all sessions for a user', async () => {
      const { service, sessionRepo } = createService();
      await service.revokeAllForUser('usr_1', 'signout_all');
      expect(sessionRepo.revokeAllForUser).toHaveBeenCalledWith('usr_1', 'signout_all', undefined, undefined);
    });
  });
});

describe('toAuthenticatedUser', () => {
  it('maps an issued session onto the request principal shape', () => {
    const issued = {
      user: user({ staffRole: 'admin' }),
      sessionId: 'ses_9',
      client: 'admin_web' as const,
      accessToken: 'a',
      accessTokenExpiresAt: new Date(),
      refreshToken: 'r',
      refreshTokenExpiresAt: new Date(),
    };
    expect(toAuthenticatedUser(issued)).toEqual({
      userId: 'usr_1',
      sessionId: 'ses_9',
      email: 'person@example.com',
      emailVerifiedAt: issued.user.emailVerifiedAt,
      staffRole: 'admin',
      client: 'admin_web',
    });
  });
});
