import { AccountLinkingService } from './account-linking.service';
import {
  hashToken,
  InvalidTokenError,
  LinkRejectedError,
  type ProviderAssertion,
} from '../domain';
import type { UserRepository, IdentityUser } from '../infrastructure/user.repository';
import type { CredentialRepository } from '../infrastructure/credential.repository';
import type { AuthIdentityRepository, AuthIdentityRecord } from '../infrastructure/auth-identity.repository';
import type { AuthTokenRepository } from '../infrastructure/auth-token.repository';
import type {
  AppleAuthGateway,
  AuditLog,
  FederatedIdTokenVerifier,
  MemberDirectory,
  SecretCipher,
} from './ports';
import { MemberClaimService } from './member-claiming';
import type { SessionService, IssuedSession } from './session.service';
import type { UnitOfWork, TransactionContext } from '@/lib/kernel/unit-of-work';

const TX = {} as TransactionContext;

function user(overrides: Partial<IdentityUser> = {}): IdentityUser {
  return {
    id: 'usr_1',
    email: 'alice@example.com',
    name: 'Alice Chen',
    staffRole: null,
    status: 'active',
    emailVerifiedAt: new Date('2026-08-01T00:00:00Z'),
    termsAcceptedAt: null,
    termsVersion: null,
    memberId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function assertion(overrides: Partial<ProviderAssertion> = {}): ProviderAssertion {
  return {
    provider: 'google',
    subject: 'google_sub_1',
    email: 'alice@example.com',
    emailVerified: true,
    isPrivateRelay: false,
    name: 'Alice Chen',
    ...overrides,
  };
}

function identityRecord(overrides: Partial<AuthIdentityRecord> = {}): AuthIdentityRecord {
  return {
    id: 'ident_1',
    userId: 'usr_1',
    provider: 'google',
    subject: 'google_sub_1',
    email: 'alice@example.com',
    emailVerified: true,
    isPrivateRelay: false,
    refreshTokenEnc: null,
    linkedAt: new Date(),
    lastUsedAt: null,
    ...overrides,
  };
}

function mockUsers(overrides: Partial<Record<string, unknown>> = {}): UserRepository {
  return {
    findByEmail: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    createUser: vi.fn().mockImplementation(async (input: { email: string; name: string; emailVerifiedAt?: Date | null }) =>
      user({ id: 'usr_new', email: input.email, name: input.name, emailVerifiedAt: input.emailVerifiedAt ?? null }),
    ),
    markEmailVerified: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UserRepository;
}

function mockIdentities(found: AuthIdentityRecord | null = null): AuthIdentityRepository {
  return {
    findByProviderSubject: vi.fn().mockResolvedValue(found),
    create: vi.fn().mockImplementation(async (input: Record<string, unknown>) => identityRecord({ id: 'ident_new', ...input })),
    touchUsed: vi.fn().mockResolvedValue(undefined),
    setRefreshToken: vi.fn().mockResolvedValue(undefined),
    listByUser: vi.fn().mockResolvedValue([]),
    deleteForUser: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthIdentityRepository;
}

function mockCredentials(hasPassword = false): CredentialRepository {
  return {
    findPassword: vi.fn().mockResolvedValue(hasPassword ? { secretHash: '$argon2id$mock' } : null),
    hasPassword: vi.fn().mockResolvedValue(hasPassword),
    upsertPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(undefined),
  } as unknown as CredentialRepository;
}

function mockTokens(consumed = true): AuthTokenRepository {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue(consumed ? { identifier: 'oauth', bindingHash: null } : null),
    invalidateAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthTokenRepository;
}

function mockVerifier(result: ProviderAssertion): FederatedIdTokenVerifier {
  return { verify: vi.fn().mockResolvedValue(result) };
}

function mockGateway(configured = false): AppleAuthGateway {
  return {
    isConfigured: vi.fn().mockReturnValue(configured),
    exchangeCode: vi.fn().mockResolvedValue({ refreshToken: 'apple_refresh' }),
  };
}

function mockCipher(): SecretCipher {
  return {
    encrypt: vi.fn((v: string) => `enc(${v})`),
    decrypt: vi.fn((v: string) => v),
  };
}

function mockDirectory(memberByEmail: { id: string; userId: string | null } | null = null): MemberDirectory {
  return {
    findByEmail: vi.fn().mockResolvedValue(memberByEmail),
    claim: vi.fn().mockResolvedValue(undefined),
    createForUser: vi.fn().mockResolvedValue({ id: 'mem_new' }),
  };
}

function mockSessions(): SessionService {
  return {
    issue: vi.fn().mockImplementation(async (u: IdentityUser, client: string): Promise<IssuedSession> => ({
      user: u,
      sessionId: 'ses_1',
      client: client as IssuedSession['client'],
      accessToken: 'access_jwt',
      accessTokenExpiresAt: new Date(Date.now() + 600_000),
      refreshToken: 'refresh_raw',
      refreshTokenExpiresAt: new Date(Date.now() + 3_600_000),
    })),
    revokeAllForUser: vi.fn().mockResolvedValue(1),
  } as unknown as SessionService;
}

function mockAudit(): AuditLog {
  return { append: vi.fn().mockResolvedValue({ id: 'evt_1', seq: 1 }) };
}

function mockUow(): UnitOfWork {
  return { execute: vi.fn((fn: (tx: TransactionContext) => Promise<unknown>) => fn(TX)) } as unknown as UnitOfWork;
}

function createService(overrides: {
  users?: UserRepository;
  identities?: AuthIdentityRepository;
  credentials?: CredentialRepository;
  tokens?: AuthTokenRepository;
  google?: FederatedIdTokenVerifier;
  apple?: FederatedIdTokenVerifier;
  gateway?: AppleAuthGateway;
  directory?: MemberDirectory;
  sessions?: SessionService;
  audit?: AuditLog;
} = {}) {
  const deps = {
    users: overrides.users ?? mockUsers(),
    identities: overrides.identities ?? mockIdentities(),
    credentials: overrides.credentials ?? mockCredentials(),
    tokens: overrides.tokens ?? mockTokens(),
    google: overrides.google ?? mockVerifier(assertion()),
    apple: overrides.apple ?? mockVerifier(assertion({ provider: 'apple', subject: 'apple_sub_1' })),
    gateway: overrides.gateway ?? mockGateway(),
    cipher: mockCipher(),
    directory: overrides.directory ?? mockDirectory(),
    sessions: overrides.sessions ?? mockSessions(),
    audit: overrides.audit ?? mockAudit(),
  };
  const memberClaims = new MemberClaimService(deps.directory, deps.audit);
  const service = new AccountLinkingService(
    deps.users,
    deps.identities,
    deps.credentials,
    deps.tokens,
    { google: deps.google, apple: deps.apple },
    deps.gateway,
    deps.cipher,
    memberClaims,
    deps.sessions,
    deps.audit,
    mockUow(),
  );
  return { service, ...deps };
}

describe('AccountLinkingService', () => {
  describe('issueNonce', () => {
    it('stores only the hash of the returned nonce', async () => {
      const { service, tokens } = createService();
      const { nonce, expiresAt } = await service.issueNonce();

      expect(tokens.create).toHaveBeenCalledWith(expect.objectContaining({
        purpose: 'oauth_nonce',
        tokenHash: hashToken(nonce),
      }));
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('nonce binding', () => {
    it('rejects a sign-in whose nonce was never issued or already burned', async () => {
      const { service, google } = createService({ tokens: mockTokens(false) });

      await expect(
        service.signInWithGoogle({ idToken: 'id_token', nonce: 'nonce' }, 'member_mobile'),
      ).rejects.toThrow(InvalidTokenError);
      expect(google.verify).not.toHaveBeenCalled();
    });

    it('passes the nonce hash to the verifier (the claim carries sha256(nonce))', async () => {
      const { service, google } = createService();
      await service.signInWithGoogle({ idToken: 'id_token', nonce: 'raw_nonce' }, 'member_mobile');
      expect(google.verify).toHaveBeenCalledWith('id_token', hashToken('raw_nonce'));
    });
  });

  describe('sign_in path (identity exists)', () => {
    it('signs in the identity owner and stamps usage', async () => {
      const identities = mockIdentities(identityRecord());
      const users = mockUsers({ findById: vi.fn().mockResolvedValue(user()) });
      const { service, sessions } = createService({ identities, users });

      const issued = await service.signInWithGoogle({ idToken: 't', nonce: 'n' }, 'member_mobile');

      expect(identities.touchUsed).toHaveBeenCalledWith('ident_1', expect.objectContaining({
        email: 'alice@example.com',
      }), TX);
      expect(sessions.issue).toHaveBeenCalledOnce();
      expect(issued.user.id).toBe('usr_1');
    });

    it('claims a member row that appeared since the last sign-in', async () => {
      const identities = mockIdentities(identityRecord());
      const users = mockUsers({ findById: vi.fn().mockResolvedValue(user()) });
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      const { service } = createService({ identities, users, directory });

      await service.signInWithGoogle({ idToken: 't', nonce: 'n' }, 'member_mobile');
      expect(directory.claim).toHaveBeenCalledWith(TX, 'mem_1', 'usr_1');
    });
  });

  describe('create_user path', () => {
    it('creates a verified user, identity and member profile', async () => {
      const { service, users, identities, directory, audit } = createService();

      const issued = await service.signInWithGoogle({ idToken: 't', nonce: 'n' }, 'member_mobile');

      expect(users.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'alice@example.com', name: 'Alice Chen' }),
        TX,
      );
      expect((users.createUser as ReturnType<typeof vi.fn>).mock.calls[0][0].emailVerifiedAt).toBeInstanceOf(Date);
      expect(identities.create).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'usr_new',
        provider: 'google',
        subject: 'google_sub_1',
      }), TX);
      expect(directory.createForUser).toHaveBeenCalledWith(TX, expect.objectContaining({
        userId: 'usr_new',
        firstName: 'Alice',
        lastName: 'Chen',
      }));
      expect(audit.append).toHaveBeenCalledWith(TX, expect.objectContaining({
        eventType: 'UserSignedUp',
        data: expect.objectContaining({ method: 'google' }),
      }));
      expect(issued.user.id).toBe('usr_new');
    });

    it('claims an existing member row instead of creating a profile', async () => {
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      const { service } = createService({ directory });

      await service.signInWithGoogle({ idToken: 't', nonce: 'n' }, 'member_mobile');
      expect(directory.claim).toHaveBeenCalledWith(TX, 'mem_1', 'usr_new');
      expect(directory.createForUser).not.toHaveBeenCalled();
    });

    it('retries once when a concurrent first sign-in wins the identity unique index', async () => {
      const identities = mockIdentities();
      (identities.findByProviderSubject as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(identityRecord());
      (identities.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ code: 'P2002' });
      const users = mockUsers({ findById: vi.fn().mockResolvedValue(user()) });
      const { service, sessions } = createService({ identities, users });

      const issued = await service.signInWithGoogle({ idToken: 't', nonce: 'n' }, 'member_mobile');
      expect(issued.user.id).toBe('usr_1');
      expect(sessions.issue).toHaveBeenCalledOnce();
    });
  });

  describe('link path', () => {
    it('links the provider onto a verified local account', async () => {
      const localUser = user();
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(localUser) });
      const { service, identities, credentials, audit } = createService({ users });

      const issued = await service.signInWithGoogle({ idToken: 't', nonce: 'n' }, 'member_mobile');

      expect(identities.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_1' }), TX);
      expect(credentials.deletePassword).not.toHaveBeenCalled();
      expect(audit.append).toHaveBeenCalledWith(TX, expect.objectContaining({
        eventType: 'IdentityLinked',
        data: expect.objectContaining({ revokedPasswordCredential: false }),
      }));
      expect(issued.user.id).toBe('usr_1');
    });

    it('pre-hijack defense: revokes password credential and sessions on an unverified local account', async () => {
      const localUser = user({ emailVerifiedAt: null });
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(localUser) });
      const { service, credentials, sessions, tokens } = createService({ users });

      await service.signInWithGoogle({ idToken: 't', nonce: 'n' }, 'member_mobile');

      expect(credentials.deletePassword).toHaveBeenCalledWith('usr_1', TX);
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('usr_1', 'identity_link_password_revoked', { tx: TX });
      expect(tokens.invalidateAll).toHaveBeenCalledWith('password_reset', 'usr_1', TX);
    });

    it('marks the local email verified when the provider vouches for it', async () => {
      const localUser = user({ emailVerifiedAt: null });
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(localUser) });
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      const { service } = createService({ users, directory });

      await service.signInWithGoogle({ idToken: 't', nonce: 'n' }, 'member_mobile');
      expect(users.markEmailVerified).toHaveBeenCalled();
      expect(directory.claim).toHaveBeenCalledWith(TX, 'mem_1', 'usr_1');
    });

    it('rejects email matching when the provider email is unverified', async () => {
      const users = mockUsers({ findByEmail: vi.fn().mockResolvedValue(user()) });
      const google = mockVerifier(assertion({ emailVerified: false }));
      const { service } = createService({ users, google });

      await expect(
        service.signInWithGoogle({ idToken: 't', nonce: 'n' }, 'member_mobile'),
      ).rejects.toThrow(LinkRejectedError);
    });
  });

  describe('Apple specifics', () => {
    it('uses the first-auth fullName when the token has no name claim', async () => {
      const apple = mockVerifier(assertion({ provider: 'apple', subject: 'apple_sub_1', name: null }));
      const { service, users } = createService({ apple });

      await service.signInWithApple(
        {
          identityToken: 't',
          nonce: 'n',
          fullName: { givenName: 'Alice', familyName: 'Chen' },
        },
        'member_mobile',
      );

      expect(users.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Alice Chen' }),
        TX,
      );
    });

    it('exchanges the authorization code and stores the refresh token encrypted', async () => {
      const gateway = mockGateway(true);
      const { service, identities, cipher } = createService({ gateway });

      await service.signInWithApple(
        { identityToken: 't', nonce: 'n', authorizationCode: 'auth_code' },
        'member_mobile',
      );

      expect(gateway.exchangeCode).toHaveBeenCalledWith('auth_code');
      expect(cipher.encrypt).toHaveBeenCalledWith('apple_refresh');
      expect(identities.setRefreshToken).toHaveBeenCalledWith('ident_new', 'enc(apple_refresh)');
    });

    it('skips the exchange when Apple signing is not configured', async () => {
      const gateway = mockGateway(false);
      const { service, identities } = createService({ gateway });

      await service.signInWithApple(
        { identityToken: 't', nonce: 'n', authorizationCode: 'auth_code' },
        'member_mobile',
      );

      expect(gateway.exchangeCode).not.toHaveBeenCalled();
      expect(identities.setRefreshToken).not.toHaveBeenCalled();
    });

    it('still signs in when the code exchange fails', async () => {
      const gateway = mockGateway(true);
      (gateway.exchangeCode as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('apple down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { service } = createService({ gateway });

      const issued = await service.signInWithApple(
        { identityToken: 't', nonce: 'n', authorizationCode: 'auth_code' },
        'member_mobile',
      );
      expect(issued.accessToken).toBe('access_jwt');
      warn.mockRestore();
    });
  });
  describe('managing links from a signed-in account', () => {
    it('lists identities and password presence', async () => {
      const identities = mockIdentities();
      (identities.listByUser as ReturnType<typeof vi.fn>).mockResolvedValue([identityRecord()]);
      const { service } = createService({ identities, credentials: mockCredentials(true) });

      const credentials = await service.listCredentials('usr_1');

      expect(credentials.hasPassword).toBe(true);
      expect(credentials.identities).toEqual([
        expect.objectContaining({ provider: 'google', email: 'alice@example.com' }),
      ]);
    });

    it('links a provider to the caller account after burning the nonce', async () => {
      const identities = mockIdentities();
      const { service, google, tokens, audit } = createService({ identities });

      const result = await service.linkProvider('usr_1', 'google', {
        idToken: 'id_token',
        nonce: 'raw_nonce',
      });

      expect(result).toEqual({ linked: true });
      expect(tokens.consume).toHaveBeenCalledWith('oauth_nonce', hashToken('raw_nonce'));
      expect(google.verify).toHaveBeenCalledWith('id_token', hashToken('raw_nonce'));
      expect(identities.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'usr_1', provider: 'google', subject: 'google_sub_1' }),
        TX,
      );
      expect(audit.append).toHaveBeenCalledWith(TX, expect.objectContaining({ eventType: 'IdentityLinked' }));
    });

    it('is a no-op when the identity is already this account', async () => {
      const identities = mockIdentities(identityRecord({ userId: 'usr_1' }));
      const { service } = createService({ identities });

      expect(await service.linkProvider('usr_1', 'google', { idToken: 't', nonce: 'n' })).toEqual({
        linked: false,
      });
      expect(identities.create).not.toHaveBeenCalled();
    });

    it('refuses to move a provider account away from another user', async () => {
      const identities = mockIdentities(identityRecord({ userId: 'usr_other' }));
      const { service } = createService({ identities });

      await expect(service.linkProvider('usr_1', 'google', { idToken: 't', nonce: 'n' }))
        .rejects.toThrow(LinkRejectedError);
      expect(identities.create).not.toHaveBeenCalled();
    });

    it('rejects a link whose nonce was never issued', async () => {
      const { service, google } = createService({ tokens: mockTokens(false) });

      await expect(service.linkProvider('usr_1', 'google', { idToken: 't', nonce: 'n' }))
        .rejects.toThrow(InvalidTokenError);
      expect(google.verify).not.toHaveBeenCalled();
    });

    it('stores the Apple refresh token when linking with an authorization code', async () => {
      const identities = mockIdentities();
      const gateway = mockGateway(true);
      const { service, cipher } = createService({ identities, gateway });

      await service.linkProvider('usr_1', 'apple', {
        idToken: 't',
        nonce: 'n',
        authorizationCode: 'auth_code',
      });

      expect(gateway.exchangeCode).toHaveBeenCalledWith('auth_code');
      expect(cipher.encrypt).toHaveBeenCalledWith('apple_refresh');
      expect(identities.setRefreshToken).toHaveBeenCalledWith('ident_new', 'enc(apple_refresh)');
    });

    it('unlinks a provider when a password remains', async () => {
      const identities = mockIdentities();
      (identities.listByUser as ReturnType<typeof vi.fn>).mockResolvedValue([identityRecord()]);
      const { service, audit } = createService({ identities, credentials: mockCredentials(true) });

      await service.unlinkProvider('usr_1', 'google');

      expect(identities.deleteForUser).toHaveBeenCalledWith('usr_1', 'google', TX);
      expect(audit.append).toHaveBeenCalledWith(TX, expect.objectContaining({ eventType: 'IdentityUnlinked' }));
    });

    it('refuses to remove the last remaining credential', async () => {
      const identities = mockIdentities();
      (identities.listByUser as ReturnType<typeof vi.fn>).mockResolvedValue([identityRecord()]);
      const { service } = createService({ identities, credentials: mockCredentials(false) });

      await expect(service.unlinkProvider('usr_1', 'google')).rejects.toThrow(LinkRejectedError);
      expect(identities.deleteForUser).not.toHaveBeenCalled();
    });
  });
});
