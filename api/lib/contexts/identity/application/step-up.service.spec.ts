import { hashToken } from '../domain';
import type { AuthIdentityRepository } from '../infrastructure/auth-identity.repository';
import type { AuthTokenRepository } from '../infrastructure/auth-token.repository';
import type { CredentialRepository } from '../infrastructure/credential.repository';
import type { FederatedIdTokenVerifier, PasswordHasher } from './ports';
import { StepUpFailedError, StepUpService } from './step-up.service';

const PRINCIPAL = {
  userId: 'usr_1',
  sessionId: 'ses_1',
  email: 'alice@example.com',
  emailVerified: true,
  staffRole: null,
  memberId: 'mem_1',
  client: 'member_mobile' as const,
  deletionRequestedAt: null,
};

function mockCredentials(hasPassword = true): CredentialRepository {
  return {
    findPassword: vi.fn().mockResolvedValue(hasPassword ? { secretHash: 'phc-hash' } : null),
    hasPassword: vi.fn().mockResolvedValue(hasPassword),
  } as unknown as CredentialRepository;
}

function mockIdentities(rows: Array<{ userId: string; provider: string; subject: string }> = []): AuthIdentityRepository {
  return {
    listByUser: vi.fn().mockResolvedValue(rows),
    findByProviderSubject: vi.fn(async (provider: string, subject: string) =>
      rows.find((row) => row.provider === provider && row.subject === subject) ?? null,
    ),
  } as unknown as AuthIdentityRepository;
}

function mockTokens(consumeResult: { identifier: string; bindingHash: string | null } | null = null): AuthTokenRepository {
  return {
    consume: vi.fn().mockResolvedValue(consumeResult),
    create: vi.fn(),
    invalidateAll: vi.fn(),
  } as unknown as AuthTokenRepository;
}

function mockHasher(valid = true): PasswordHasher {
  return {
    hash: vi.fn().mockResolvedValue('phc-equalizer'),
    verify: vi.fn().mockResolvedValue(valid),
    needsRehash: vi.fn().mockReturnValue(false),
  };
}

function mockVerifier(subject: string | null): FederatedIdTokenVerifier {
  return {
    verify: subject
      ? vi.fn().mockResolvedValue({ provider: 'google', subject, email: null, emailVerified: false, isPrivateRelay: false })
      : vi.fn().mockRejectedValue(new Error('bad token')),
  };
}

const notifications = { sendAccountReauth: vi.fn() } as any;

function build(overrides: {
  credentials?: CredentialRepository;
  identities?: AuthIdentityRepository;
  tokens?: AuthTokenRepository;
  hasher?: PasswordHasher;
  google?: FederatedIdTokenVerifier;
} = {}) {
  return new StepUpService(
    overrides.credentials ?? mockCredentials(),
    overrides.identities ?? mockIdentities(),
    overrides.tokens ?? mockTokens(),
    overrides.hasher ?? mockHasher(),
    { google: overrides.google ?? mockVerifier('sub_1'), apple: mockVerifier('sub_apple') },
    notifications,
  );
}

describe('StepUpService password proof', () => {
  it('accepts the correct current password', async () => {
    const service = build();
    expect(await service.verify(PRINCIPAL, { kind: 'password', password: 'correct' })).toBe('password');
  });

  it('rejects a wrong password', async () => {
    const service = build({ hasher: mockHasher(false) });
    await expect(service.verify(PRINCIPAL, { kind: 'password', password: 'wrong' })).rejects.toThrow(StepUpFailedError);
  });

  it('runs a real verify even when the account has no password (timing)', async () => {
    const hasher = mockHasher(true);
    const service = build({ credentials: mockCredentials(false), hasher });
    await expect(service.verify(PRINCIPAL, { kind: 'password', password: 'anything' })).rejects.toThrow(StepUpFailedError);
    expect(hasher.verify).toHaveBeenCalled(); // equalizer ran
  });
});

describe('StepUpService oauth proof', () => {
  it('accepts a fresh assertion whose subject is linked to THIS user', async () => {
    const tokens = mockTokens({ identifier: 'oauth', bindingHash: null });
    const identities = mockIdentities([{ userId: 'usr_1', provider: 'google', subject: 'sub_1' }]);
    const service = build({ tokens, identities });

    expect(
      await service.verify(PRINCIPAL, { kind: 'oauth', provider: 'google', idToken: 'idt', nonce: 'nonce' }),
    ).toBe('oauth');
    expect(tokens.consume).toHaveBeenCalledWith('oauth_nonce', hashToken('nonce'));
  });

  it("REJECTS a valid token for someone else's provider account (subject binding)", async () => {
    const tokens = mockTokens({ identifier: 'oauth', bindingHash: null });
    // The subject exists but belongs to another user.
    const identities = mockIdentities([{ userId: 'usr_ATTACKER', provider: 'google', subject: 'sub_1' }]);
    const service = build({ tokens, identities });

    await expect(
      service.verify(PRINCIPAL, { kind: 'oauth', provider: 'google', idToken: 'idt', nonce: 'nonce' }),
    ).rejects.toThrow(StepUpFailedError);
  });

  it('rejects a burned or unknown nonce', async () => {
    const service = build({ tokens: mockTokens(null) });
    await expect(
      service.verify(PRINCIPAL, { kind: 'oauth', provider: 'google', idToken: 'idt', nonce: 'stale' }),
    ).rejects.toThrow(StepUpFailedError);
  });

  it('rejects an unverifiable ID token', async () => {
    const service = build({ tokens: mockTokens({ identifier: 'oauth', bindingHash: null }), google: mockVerifier(null) });
    await expect(
      service.verify(PRINCIPAL, { kind: 'oauth', provider: 'google', idToken: 'garbage', nonce: 'nonce' }),
    ).rejects.toThrow(StepUpFailedError);
  });
});

describe('StepUpService reauth_email proof', () => {
  it('mints a token bound to the userId AND the current session', async () => {
    const tokens = mockTokens();
    const service = build({ tokens });

    await service.sendReauthEmail(PRINCIPAL);

    expect(tokens.invalidateAll).toHaveBeenCalledWith('reauth', 'usr_1');
    const created = (tokens.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.purpose).toBe('reauth');
    expect(created.identifier).toBe('usr_1');
    expect(created.bindingHash).toBe(hashToken('ses_1'));
    expect(notifications.sendAccountReauth).toHaveBeenCalledWith('alice@example.com', expect.any(String));
  });

  it('accepts a token bound to this user and session', async () => {
    const tokens = mockTokens({ identifier: 'usr_1', bindingHash: hashToken('ses_1') });
    const service = build({ tokens });
    expect(await service.verify(PRINCIPAL, { kind: 'reauth_email', token: 'raw' })).toBe('reauth_email');
  });

  it("REJECTS a token minted for another account (the hijacker's own)", async () => {
    const tokens = mockTokens({ identifier: 'usr_ATTACKER', bindingHash: hashToken('ses_1') });
    const service = build({ tokens });
    await expect(service.verify(PRINCIPAL, { kind: 'reauth_email', token: 'raw' })).rejects.toThrow(StepUpFailedError);
  });

  it('REJECTS a token minted on a different session', async () => {
    const tokens = mockTokens({ identifier: 'usr_1', bindingHash: hashToken('ses_OTHER') });
    const service = build({ tokens });
    await expect(service.verify(PRINCIPAL, { kind: 'reauth_email', token: 'raw' })).rejects.toThrow(StepUpFailedError);
  });
});

describe('StepUpService.acceptableMethods', () => {
  it('lists what the account can actually prove with', async () => {
    const service = build({
      credentials: mockCredentials(false),
      identities: mockIdentities([{ userId: 'usr_1', provider: 'apple', subject: 's' }]),
    });
    expect(await service.acceptableMethods('usr_1')).toEqual(['oauth', 'reauth_email']);
  });
});
