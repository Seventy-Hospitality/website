import type { UnitOfWork } from '@/lib/kernel/unit-of-work';
import { IdentityConfigError } from '../domain';
import type { AuthIdentityRepository } from '../infrastructure/auth-identity.repository';
import type { AuthTokenRepository } from '../infrastructure/auth-token.repository';
import type { CredentialRepository } from '../infrastructure/credential.repository';
import type { UserRepository } from '../infrastructure/user.repository';
import { AccountErasureService } from './account-erasure.service';
import type { AppleAuthGateway, AuditLog, SecretCipher } from './ports';
import type { SessionService } from './session.service';

function mockUow(): UnitOfWork {
  return { execute: vi.fn(async (fn: any) => fn({})) } as unknown as UnitOfWork;
}

function build(overrides: {
  identities?: Array<{ provider: string; refreshTokenEnc: string | null }>;
  appleConfigured?: boolean;
  revokeError?: Error;
  decryptError?: boolean;
} = {}) {
  const users = {
    markDeletionRequested: vi.fn(),
    tombstoneForDeletion: vi.fn(),
  } as unknown as UserRepository;
  const credentials = { deletePassword: vi.fn() } as unknown as CredentialRepository;
  const identityRepo = {
    listByUser: vi.fn().mockResolvedValue(overrides.identities ?? []),
    deleteAllForUser: vi.fn(),
  } as unknown as AuthIdentityRepository;
  const tokens = { invalidateAll: vi.fn() } as unknown as AuthTokenRepository;
  const sessions = { revokeAllForUser: vi.fn().mockResolvedValue(2) } as unknown as SessionService;
  const appleGateway: AppleAuthGateway = {
    isConfigured: vi.fn().mockReturnValue(overrides.appleConfigured ?? true),
    exchangeCode: vi.fn(),
    revoke: overrides.revokeError
      ? vi.fn().mockRejectedValue(overrides.revokeError)
      : vi.fn().mockResolvedValue(undefined),
  };
  const cipher: SecretCipher = {
    encrypt: vi.fn(),
    decrypt: overrides.decryptError
      ? vi.fn(() => {
          throw new Error('bad tag');
        })
      : vi.fn().mockReturnValue('raw-refresh-token'),
  };
  const audit: AuditLog = { append: vi.fn().mockResolvedValue({}) };
  const service = new AccountErasureService(
    users,
    credentials,
    identityRepo,
    tokens,
    sessions,
    appleGateway,
    cipher,
    audit,
    mockUow(),
  );
  return { service, users, credentials, identityRepo, tokens, sessions, appleGateway, cipher, audit };
}

describe('AccountErasureService.quiesce', () => {
  it('freeze-stamps the user and revokes every OTHER session', async () => {
    const { service, users, sessions } = build();
    const when = new Date('2026-08-11T12:00:00Z');

    await service.quiesce('usr_1', 'ses_current', when);

    expect(users.markDeletionRequested).toHaveBeenCalledWith('usr_1', when, expect.anything());
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
      'usr_1',
      'account_deletion',
      expect.objectContaining({ exceptSessionId: 'ses_current' }),
    );
  });
});

describe('AccountErasureService.revokeAppleTokens', () => {
  it('is not applicable without a stored Apple refresh token', async () => {
    const { service, appleGateway } = build({
      identities: [{ provider: 'google', refreshTokenEnc: null }],
    });
    expect(await service.revokeAppleTokens('usr_1')).toBe('not_applicable');
    expect(appleGateway.revoke).not.toHaveBeenCalled();
  });

  it('revokes each stored token before the identity rows die', async () => {
    const { service, appleGateway, identityRepo } = build({
      identities: [{ provider: 'apple', refreshTokenEnc: 'v1:cipher' }],
    });
    expect(await service.revokeAppleTokens('usr_1')).toBe('revoked');
    expect(appleGateway.revoke).toHaveBeenCalledWith('raw-refresh-token');
    // Revocation NEVER deletes rows itself; erasure is a separate step.
    expect((identityRepo as any).deleteAllForUser).not.toHaveBeenCalled();
  });

  it('throws (retryable) when a stored token exists but the gateway is unconfigured', async () => {
    const { service } = build({
      identities: [{ provider: 'apple', refreshTokenEnc: 'v1:cipher' }],
      appleConfigured: false,
    });
    await expect(service.revokeAppleTokens('usr_1')).rejects.toThrow(IdentityConfigError);
  });

  it('throws on a transient revoke failure so the pipeline retries', async () => {
    const { service } = build({
      identities: [{ provider: 'apple', refreshTokenEnc: 'v1:cipher' }],
      revokeError: new Error('apple 500'),
    });
    await expect(service.revokeAppleTokens('usr_1')).rejects.toThrow('apple 500');
  });

  it('classifies an undecryptable token (rotated secret) instead of crashing', async () => {
    const { service, appleGateway } = build({
      identities: [{ provider: 'apple', refreshTokenEnc: 'v1:cipher' }],
      decryptError: true,
    });
    expect(await service.revokeAppleTokens('usr_1')).toBe('undecryptable');
    expect(appleGateway.revoke).not.toHaveBeenCalled();
  });
});

describe('AccountErasureService.eraseCredentials', () => {
  it('deletes every way in, burns magic links by the PRE-tombstone email, revokes all sessions', async () => {
    const { service, credentials, identityRepo, tokens, sessions } = build();

    await service.eraseCredentials('usr_1', 'Alice@Example.com ');

    expect(credentials.deletePassword).toHaveBeenCalledWith('usr_1', expect.anything());
    expect((identityRepo as any).deleteAllForUser).toHaveBeenCalledWith('usr_1', expect.anything());
    // Magic links key on the (normalized) email, everything else on userId.
    expect(tokens.invalidateAll).toHaveBeenCalledWith('magic_link', 'alice@example.com', expect.anything());
    expect(tokens.invalidateAll).toHaveBeenCalledWith('password_reset', 'usr_1', expect.anything());
    expect(tokens.invalidateAll).toHaveBeenCalledWith('email_verification', 'usr_1', expect.anything());
    expect(tokens.invalidateAll).toHaveBeenCalledWith('reauth', 'usr_1', expect.anything());
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('usr_1', 'account_deletion', expect.anything());
  });
});

describe('AccountErasureService.tombstoneUser', () => {
  it('soft-deletes through the repository', async () => {
    const { service, users } = build();
    const when = new Date('2026-08-11T13:00:00Z');
    await service.tombstoneUser('usr_1', when);
    expect(users.tombstoneForDeletion).toHaveBeenCalledWith('usr_1', when, expect.anything());
  });
});
