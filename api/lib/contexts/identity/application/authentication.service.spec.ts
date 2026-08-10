import { AuthenticationService } from './authentication.service';
import { MemberClaimService } from './member-claiming';
import {
  hashToken,
  EmailInUseError,
  InvalidCredentialsError,
  InvalidTokenError,
  AccountUnavailableError,
  NotAuthorizedError,
} from '../domain';
import type { UserRepository, IdentityUser } from '../infrastructure/user.repository';
import type { CredentialRepository } from '../infrastructure/credential.repository';
import type { AuthTokenRepository } from '../infrastructure/auth-token.repository';
import type { AuditLog, MemberDirectory, PasswordHasher } from './ports';
import type { SessionService, IssuedSession } from './session.service';
import type { NotificationService } from '@/lib/contexts/communications/application';
import type { UnitOfWork, TransactionContext } from '@/lib/kernel/unit-of-work';

const TX = {} as TransactionContext;

function user(overrides: Partial<IdentityUser> = {}): IdentityUser {
  return {
    id: 'usr_1',
    email: 'alice@example.com',
    name: 'Alice Chen',
    staffRole: null,
    status: 'active',
    emailVerifiedAt: null,
    termsAcceptedAt: null,
    termsVersion: null,
    memberId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function issuedSession(u: IdentityUser = user()): IssuedSession {
  return {
    user: u,
    sessionId: 'ses_1',
    client: 'member_mobile',
    accessToken: 'access_jwt',
    accessTokenExpiresAt: new Date(Date.now() + 600_000),
    refreshToken: 'refresh_raw',
    refreshTokenExpiresAt: new Date(Date.now() + 3_600_000),
  };
}

function mockUsers(overrides: Partial<Record<keyof UserRepository, unknown>> = {}): UserRepository {
  return {
    findByEmail: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    createUser: vi.fn().mockImplementation(async (input: { email: string; name: string }) =>
      user({ email: input.email, name: input.name }),
    ),
    markEmailVerified: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UserRepository;
}

function mockCredentials(secretHash: string | null = null): CredentialRepository {
  return {
    findPassword: vi.fn().mockResolvedValue(secretHash ? { secretHash } : null),
    upsertPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(undefined),
  } as unknown as CredentialRepository;
}

function mockTokens(): AuthTokenRepository {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue(null),
    invalidateAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthTokenRepository;
}

function mockHasher(): PasswordHasher {
  return {
    hash: vi.fn().mockResolvedValue('$argon2id$mock'),
    verify: vi.fn().mockResolvedValue(true),
    needsRehash: vi.fn().mockReturnValue(false),
  };
}

function mockSessions(): SessionService {
  return {
    issue: vi.fn().mockImplementation(async (u: IdentityUser) => issuedSession(u)),
    revokeAllForUser: vi.fn().mockResolvedValue(1),
  } as unknown as SessionService;
}

function mockDirectory(memberByEmail: { id: string; userId: string | null } | null = null): MemberDirectory {
  return {
    findByEmail: vi.fn().mockResolvedValue(memberByEmail),
    claim: vi.fn().mockResolvedValue(undefined),
    createForUser: vi.fn().mockResolvedValue({ id: 'mem_new' }),
  };
}

function mockNotifications(): NotificationService {
  return {
    sendMagicLink: vi.fn().mockResolvedValue(undefined),
    sendEmailVerification: vi.fn().mockResolvedValue(undefined),
    sendPasswordReset: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationService;
}

function mockAudit(): AuditLog {
  return { append: vi.fn().mockResolvedValue({ id: 'evt_1', seq: 1 }) };
}

function mockUow(): UnitOfWork {
  return { execute: vi.fn((fn: (tx: TransactionContext) => Promise<unknown>) => fn(TX)) } as unknown as UnitOfWork;
}

function createService(overrides: {
  users?: UserRepository;
  credentials?: CredentialRepository;
  tokens?: AuthTokenRepository;
  hasher?: PasswordHasher;
  sessions?: SessionService;
  directory?: MemberDirectory;
  notifications?: NotificationService;
  audit?: AuditLog;
} = {}) {
  const deps = {
    users: overrides.users ?? mockUsers(),
    credentials: overrides.credentials ?? mockCredentials(),
    tokens: overrides.tokens ?? mockTokens(),
    hasher: overrides.hasher ?? mockHasher(),
    sessions: overrides.sessions ?? mockSessions(),
    directory: overrides.directory ?? mockDirectory(),
    notifications: overrides.notifications ?? mockNotifications(),
    audit: overrides.audit ?? mockAudit(),
  };
  const memberClaims = new MemberClaimService(deps.directory, deps.audit);
  const service = new AuthenticationService(
    deps.users,
    deps.credentials,
    deps.tokens,
    deps.hasher,
    deps.sessions,
    memberClaims,
    deps.notifications,
    deps.audit,
    mockUow(),
    'https://api.test',
    'https://app.test',
  );
  return { service, ...deps };
}

describe('AuthenticationService', () => {
  describe('signUp', () => {
    it('creates user, password credential and member profile, then issues a session', async () => {
      const { service, users, credentials, directory, sessions, audit } = createService();

      const issued = await service.signUp(
        { name: 'Alice Chen', email: 'Alice@Example.com ', password: 'hunter2hunter2', phone: '555-0101' },
        'member_mobile',
      );

      expect(users.createUser).toHaveBeenCalledWith({ email: 'alice@example.com', name: 'Alice Chen' }, TX);
      expect(credentials.upsertPassword).toHaveBeenCalledWith('usr_1', '$argon2id$mock', TX);
      expect(directory.createForUser).toHaveBeenCalledWith(TX, {
        userId: 'usr_1',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'Chen',
        phone: '555-0101',
      });
      expect(audit.append).toHaveBeenCalledWith(TX, expect.objectContaining({ eventType: 'UserSignedUp' }));
      expect(sessions.issue).toHaveBeenCalledOnce();
      expect(issued.user.email).toBe('alice@example.com');
    });

    it('sends a verification email with a hashed stored token', async () => {
      const { service, tokens, notifications } = createService();
      await service.signUp(
        { name: 'Alice Chen', email: 'alice@example.com', password: 'hunter2hunter2' },
        'member_mobile',
      );

      expect(tokens.create).toHaveBeenCalledWith(expect.objectContaining({
        purpose: 'email_verification',
        identifier: 'usr_1',
      }));
      const sendArgs = (notifications.sendEmailVerification as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sendArgs[0]).toBe('alice@example.com');
      expect(sendArgs[1]).toContain('https://app.test/verify-email?token=');
    });

    it('does not create a member profile when a claim candidate exists', async () => {
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      const { service } = createService({ directory });
      await service.signUp(
        { name: 'Alice Chen', email: 'alice@example.com', password: 'hunter2hunter2' },
        'member_mobile',
      );

      // Unverified signup never claims; the claim happens at verification.
      expect(directory.claim).not.toHaveBeenCalled();
      expect(directory.createForUser).not.toHaveBeenCalled();
    });

    it('maps a unique violation to EmailInUseError', async () => {
      const users = mockUsers({ createUser: vi.fn().mockRejectedValue({ code: 'P2002' }) });
      const { service } = createService({ users });
      await expect(
        service.signUp({ name: 'A', email: 'a@b.com', password: 'hunter2hunter2' }, 'member_mobile'),
      ).rejects.toThrow(EmailInUseError);
    });

    it('still returns a session when the verification email fails to send', async () => {
      const notifications = mockNotifications();
      (notifications.sendEmailVerification as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('smtp down'));
      const { service } = createService({ notifications });

      const issued = await service.signUp(
        { name: 'A B', email: 'a@b.com', password: 'hunter2hunter2' },
        'member_mobile',
      );
      expect(issued.accessToken).toBe('access_jwt');
    });
  });

  describe('signIn', () => {
    it('issues a session for valid credentials', async () => {
      const alice = user();
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(alice) });
      const { service, sessions } = createService({ users, credentials: mockCredentials('$argon2id$stored') });

      await service.signIn('Alice@Example.com', 'hunter2hunter2', 'member_mobile');
      expect(users.findByEmail).toHaveBeenCalledWith('alice@example.com');
      expect(sessions.issue).toHaveBeenCalledWith(alice, 'member_mobile', undefined);
    });

    it('rejects a wrong password', async () => {
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(user()) });
      const hasher = mockHasher();
      (hasher.verify as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const { service } = createService({ users, hasher, credentials: mockCredentials('$argon2id$stored') });

      await expect(service.signIn('alice@example.com', 'wrong', 'member_mobile')).rejects.toThrow(
        InvalidCredentialsError,
      );
    });

    it('rejects an unknown email but still burns a hash verification (timing)', async () => {
      const hasher = mockHasher();
      const { service } = createService({ hasher });

      await expect(service.signIn('ghost@example.com', 'pw', 'member_mobile')).rejects.toThrow(
        InvalidCredentialsError,
      );
      expect(hasher.verify).toHaveBeenCalledOnce();
    });

    it('rejects an account without a password credential', async () => {
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(user()) });
      const { service } = createService({ users, credentials: mockCredentials(null) });

      await expect(service.signIn('alice@example.com', 'pw', 'member_mobile')).rejects.toThrow(
        InvalidCredentialsError,
      );
    });

    it('rejects a suspended account after password verification', async () => {
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(user({ status: 'suspended' })) });
      const { service } = createService({ users, credentials: mockCredentials('$argon2id$stored') });

      await expect(service.signIn('alice@example.com', 'pw', 'member_mobile')).rejects.toThrow(
        AccountUnavailableError,
      );
    });

    it('rehashes on login when parameters are stale', async () => {
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(user()) });
      const hasher = mockHasher();
      (hasher.needsRehash as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const credentials = mockCredentials('$argon2id$old-params');
      const { service } = createService({ users, hasher, credentials });

      await service.signIn('alice@example.com', 'hunter2hunter2', 'member_mobile');
      expect(credentials.upsertPassword).toHaveBeenCalledWith('usr_1', '$argon2id$mock');
    });
  });

  describe('verifyEmail', () => {
    it('marks the email verified and claims a waiting member row', async () => {
      const tokens = mockTokens();
      (tokens.consume as ReturnType<typeof vi.fn>).mockResolvedValue({ identifier: 'usr_1', bindingHash: null });
      const users = mockUsers({ findById: vi.fn().mockResolvedValue(user()) });
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      const audit = mockAudit();
      const { service } = createService({ tokens, users, directory, audit });

      const result = await service.verifyEmail('raw_token');

      expect(tokens.consume).toHaveBeenCalledWith('email_verification', hashToken('raw_token'), TX);
      expect(users.markEmailVerified).toHaveBeenCalled();
      expect(directory.claim).toHaveBeenCalledWith(TX, 'mem_1', 'usr_1');
      expect(audit.append).toHaveBeenCalledWith(TX, expect.objectContaining({ eventType: 'EmailVerified' }));
      expect(audit.append).toHaveBeenCalledWith(TX, expect.objectContaining({ eventType: 'MemberClaimed' }));
      expect(result).toEqual({ verified: true, claimedMemberId: 'mem_1' });
    });

    it('rejects an unknown or consumed token', async () => {
      const { service } = createService();
      await expect(service.verifyEmail('bad')).rejects.toThrow(InvalidTokenError);
    });

    it('is idempotent for an already-verified account', async () => {
      const tokens = mockTokens();
      (tokens.consume as ReturnType<typeof vi.fn>).mockResolvedValue({ identifier: 'usr_1', bindingHash: null });
      const users = mockUsers({
        findById: vi.fn().mockResolvedValue(user({ emailVerifiedAt: new Date() })),
      });
      const { service } = createService({ tokens, users });

      const result = await service.verifyEmail('raw_token');
      expect(result).toEqual({ verified: true, claimedMemberId: null });
      expect(users.markEmailVerified).not.toHaveBeenCalled();
    });
  });

  describe('resendVerification', () => {
    it('sends a fresh token and invalidates outstanding ones', async () => {
      const users = mockUsers({ findById: vi.fn().mockResolvedValue(user()) });
      const tokens = mockTokens();
      const { service, notifications } = createService({ users, tokens });

      await service.resendVerification('usr_1');
      expect(tokens.invalidateAll).toHaveBeenCalledWith('email_verification', 'usr_1');
      expect(notifications.sendEmailVerification).toHaveBeenCalledOnce();
    });

    it('does nothing for an already-verified account', async () => {
      const users = mockUsers({ findById: vi.fn().mockResolvedValue(user({ emailVerifiedAt: new Date() })) });
      const { service, notifications } = createService({ users });

      await service.resendVerification('usr_1');
      expect(notifications.sendEmailVerification).not.toHaveBeenCalled();
    });
  });

  describe('requestPasswordReset', () => {
    it('stays silent for an unknown email', async () => {
      const { service, tokens, notifications } = createService();
      await service.requestPasswordReset('ghost@example.com');
      expect(tokens.create).not.toHaveBeenCalled();
      expect(notifications.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('invalidates outstanding reset tokens and emails a new one', async () => {
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(user()) });
      const { service, tokens, notifications } = createService({ users });

      await service.requestPasswordReset('alice@example.com');
      expect(tokens.invalidateAll).toHaveBeenCalledWith('password_reset', 'usr_1');
      expect(tokens.create).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'password_reset' }));
      const sendArgs = (notifications.sendPasswordReset as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sendArgs[1]).toContain('https://app.test/reset-password?token=');
    });
  });

  describe('resetPassword', () => {
    it('replaces the credential, revokes all sessions and invalidates tokens', async () => {
      const tokens = mockTokens();
      (tokens.consume as ReturnType<typeof vi.fn>).mockResolvedValue({ identifier: 'usr_1', bindingHash: null });
      const users = mockUsers({ findById: vi.fn().mockResolvedValue(user({ emailVerifiedAt: new Date() })) });
      const { service, credentials, sessions, audit } = createService({ tokens, users });

      await service.resetPassword('raw_token', 'newpassword123');

      expect(credentials.upsertPassword).toHaveBeenCalledWith('usr_1', '$argon2id$mock', TX);
      expect(tokens.invalidateAll).toHaveBeenCalledWith('password_reset', 'usr_1', TX);
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('usr_1', 'password_reset');
      expect(audit.append).toHaveBeenCalledWith(TX, expect.objectContaining({ eventType: 'PasswordReset' }));
    });

    it('treats a completed reset as proof of inbox ownership', async () => {
      const tokens = mockTokens();
      (tokens.consume as ReturnType<typeof vi.fn>).mockResolvedValue({ identifier: 'usr_1', bindingHash: null });
      const users = mockUsers({ findById: vi.fn().mockResolvedValue(user({ emailVerifiedAt: null })) });
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      const { service } = createService({ tokens, users, directory });

      await service.resetPassword('raw_token', 'newpassword123');
      expect(users.markEmailVerified).toHaveBeenCalled();
      expect(directory.claim).toHaveBeenCalledWith(TX, 'mem_1', 'usr_1');
    });

    it('rejects an invalid token', async () => {
      const { service } = createService();
      await expect(service.resetPassword('bad', 'newpassword123')).rejects.toThrow(InvalidTokenError);
    });
  });

  describe('magic link', () => {
    it('creates token and sends notification for admin users', async () => {
      const admin = user({ email: 'admin@example.com', staffRole: 'admin' });
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(admin) });
      const { service, tokens, notifications } = createService({ users });

      await service.sendMagicLink('admin@example.com');
      expect(tokens.create).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'magic_link' }));
      const sendArgs = (notifications.sendMagicLink as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sendArgs[1]).toContain('https://api.test/api/auth/verify?token=');
    });

    it('sends to plain member accounts too (recovery path)', async () => {
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(user()) });
      const { service, tokens, notifications } = createService({ users });

      await service.sendMagicLink('alice@example.com');
      expect(tokens.create).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'magic_link' }));
      expect(notifications.sendMagicLink).toHaveBeenCalled();
    });

    it('silently skips unknown and suspended accounts', async () => {
      const { service, tokens, notifications } = createService();
      await service.sendMagicLink('nobody@example.com');

      const suspended = mockUsers({ findByEmail: vi.fn().mockResolvedValue(user({ status: 'suspended' })) });
      const { service: suspendedService } = createService({ users: suspended });
      await suspendedService.sendMagicLink('alice@example.com');

      expect(tokens.create).not.toHaveBeenCalled();
      expect(notifications.sendMagicLink).not.toHaveBeenCalled();
    });

    it('verifies a magic link into a session for an admin', async () => {
      const tokens = mockTokens();
      (tokens.consume as ReturnType<typeof vi.fn>).mockResolvedValue({
        identifier: 'admin@example.com',
        bindingHash: null,
      });
      const admin = user({ email: 'admin@example.com', staffRole: 'admin', emailVerifiedAt: new Date() });
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(admin) });
      const { service, sessions } = createService({ tokens, users });

      await service.verifyMagicLink('raw_token', 'admin_web');
      expect(tokens.consume).toHaveBeenCalledWith('magic_link', hashToken('raw_token'), TX);
      expect(sessions.issue).toHaveBeenCalledWith(admin, 'admin_web', undefined);
    });

    it('rejects an unknown token', async () => {
      const { service } = createService();
      await expect(service.verifyMagicLink('unknown', 'admin_web')).rejects.toThrow(InvalidTokenError);
    });

    it('signs in a member and verifies their email, claiming a member profile', async () => {
      const tokens = mockTokens();
      (tokens.consume as ReturnType<typeof vi.fn>).mockResolvedValue({
        identifier: 'alice@example.com',
        bindingHash: null,
      });
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(user()) });
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      const { service, sessions } = createService({ tokens, users, directory });

      await service.verifyMagicLink('raw_token', 'member_mobile');
      expect(users.markEmailVerified).toHaveBeenCalled();
      expect(directory.claim).toHaveBeenCalledWith(TX, 'mem_1', 'usr_1');
      expect(sessions.issue).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'usr_1' }),
        'member_mobile',
        undefined,
      );
    });

    it('rejects a suspended account', async () => {
      const tokens = mockTokens();
      (tokens.consume as ReturnType<typeof vi.fn>).mockResolvedValue({
        identifier: 'alice@example.com',
        bindingHash: null,
      });
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(user({ status: 'suspended' })) });
      const { service } = createService({ tokens, users });

      await expect(service.verifyMagicLink('raw_token', 'admin_web')).rejects.toThrow(NotAuthorizedError);
    });
  });
});
