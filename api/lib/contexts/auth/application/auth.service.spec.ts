import { AuthService } from './auth.service';
import { InvalidTokenError, SessionExpiredError, hashToken } from '../domain';
import type { SessionRepository } from '../infrastructure/session.repository';
import type { MagicLinkRepository } from '../infrastructure/magic-link.repository';
import type { JwtService } from '../infrastructure/jwt.service';
import type { NotificationService } from '@/lib/contexts/communications/application';

function mockSessionRepo(): SessionRepository {
  return {
    create: vi.fn().mockResolvedValue({
      id: 'ses_1',
      userId: 'usr_1',
      email: 'test@example.com',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      lastActiveAt: new Date(),
      createdAt: new Date(),
    }),
    findById: vi.fn(),
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    evictOldest: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionRepository;
}

function mockMagicLinkRepo(): MagicLinkRepository {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    findByHash: vi.fn(),
    markUsed: vi.fn().mockResolvedValue(undefined),
  } as unknown as MagicLinkRepository;
}

function mockJwt(): JwtService {
  return {
    sign: vi.fn().mockResolvedValue('jwt_token_here'),
    verify: vi.fn(),
  } as unknown as JwtService;
}

function mockNotifications(): NotificationService {
  return {
    sendMagicLink: vi.fn().mockResolvedValue(undefined),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    sendPaymentFailed: vi.fn().mockResolvedValue(undefined),
    sendMembershipCanceled: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationService;
}

describe('AuthService', () => {
  describe('sendMagicLink', () => {
    it('creates token and sends notification', async () => {
      const magicLinkRepo = mockMagicLinkRepo();
      const notifications = mockNotifications();

      const service = new AuthService(mockSessionRepo(), magicLinkRepo, mockJwt(), notifications, 'https://app.com');
      await service.sendMagicLink('test@example.com');

      expect(magicLinkRepo.create).toHaveBeenCalledOnce();
      const [email, hash, expiresAt] = (magicLinkRepo.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(email).toBe('test@example.com');
      expect(typeof hash).toBe('string');
      expect(expiresAt).toBeInstanceOf(Date);

      expect(notifications.sendMagicLink).toHaveBeenCalledOnce();
      const [sentTo, url] = (notifications.sendMagicLink as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sentTo).toBe('test@example.com');
      expect(url).toContain('https://app.com/api/auth/verify?token=');
    });
  });

  describe('verifyMagicLink', () => {
    it('creates session and returns JWT on valid token', async () => {
      const magicLinkRepo = mockMagicLinkRepo();
      const sessionRepo = mockSessionRepo();
      const jwt = mockJwt();

      const token = 'abc123';
      (magicLinkRepo.findByHash as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'ml_1',
        email: 'test@example.com',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        usedAt: null,
        createdAt: new Date(),
      });

      const service = new AuthService(sessionRepo, magicLinkRepo, jwt, mockNotifications(), 'https://app.com');
      const result = await service.verifyMagicLink(token);

      expect(magicLinkRepo.markUsed).toHaveBeenCalledWith('ml_1');
      expect(sessionRepo.evictOldest).toHaveBeenCalled();
      expect(sessionRepo.create).toHaveBeenCalled();
      expect(jwt.sign).toHaveBeenCalled();
      expect(result.jwt).toBe('jwt_token_here');
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('throws InvalidTokenError for unknown token', async () => {
      const magicLinkRepo = mockMagicLinkRepo();
      (magicLinkRepo.findByHash as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new AuthService(mockSessionRepo(), magicLinkRepo, mockJwt(), mockNotifications(), 'https://app.com');
      await expect(service.verifyMagicLink('unknown')).rejects.toThrow(InvalidTokenError);
    });

    it('throws InvalidTokenError for used token', async () => {
      const magicLinkRepo = mockMagicLinkRepo();
      (magicLinkRepo.findByHash as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'ml_1',
        email: 'test@example.com',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        usedAt: new Date(), // already used
        createdAt: new Date(),
      });

      const service = new AuthService(mockSessionRepo(), magicLinkRepo, mockJwt(), mockNotifications(), 'https://app.com');
      await expect(service.verifyMagicLink('token')).rejects.toThrow(InvalidTokenError);
    });

    it('throws InvalidTokenError for expired token', async () => {
      const magicLinkRepo = mockMagicLinkRepo();
      (magicLinkRepo.findByHash as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'ml_1',
        email: 'test@example.com',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() - 1000), // expired
        usedAt: null,
        createdAt: new Date(),
      });

      const service = new AuthService(mockSessionRepo(), magicLinkRepo, mockJwt(), mockNotifications(), 'https://app.com');
      await expect(service.verifyMagicLink('token')).rejects.toThrow(InvalidTokenError);
    });
  });

  describe('validateSession', () => {
    it('returns authenticated user for valid session', async () => {
      const sessionRepo = mockSessionRepo();
      const jwt = mockJwt();

      (jwt.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ sub: 'usr_1', sid: 'ses_1', email: 'test@example.com' });
      (sessionRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'ses_1',
        userId: 'usr_1',
        email: 'test@example.com',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        lastActiveAt: new Date(),
        createdAt: new Date(),
      });

      const service = new AuthService(sessionRepo, mockMagicLinkRepo(), jwt, mockNotifications(), 'https://app.com');
      const user = await service.validateSession('jwt_token');

      expect(user.userId).toBe('usr_1');
      expect(user.sessionId).toBe('ses_1');
      expect(user.email).toBe('test@example.com');
    });

    it('throws SessionExpiredError for invalid JWT', async () => {
      const jwt = mockJwt();
      (jwt.verify as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new AuthService(mockSessionRepo(), mockMagicLinkRepo(), jwt, mockNotifications(), 'https://app.com');
      await expect(service.validateSession('bad_jwt')).rejects.toThrow(SessionExpiredError);
    });

    it('throws SessionExpiredError for missing session', async () => {
      const sessionRepo = mockSessionRepo();
      const jwt = mockJwt();

      (jwt.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ sub: 'usr_1', sid: 'ses_gone', email: 'test@example.com' });
      (sessionRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new AuthService(sessionRepo, mockMagicLinkRepo(), jwt, mockNotifications(), 'https://app.com');
      await expect(service.validateSession('jwt_token')).rejects.toThrow(SessionExpiredError);
    });
  });

  describe('logout', () => {
    it('deletes the session', async () => {
      const sessionRepo = mockSessionRepo();
      const service = new AuthService(sessionRepo, mockMagicLinkRepo(), mockJwt(), mockNotifications(), 'https://app.com');

      await service.logout('ses_1');
      expect(sessionRepo.delete).toHaveBeenCalledWith('ses_1');
    });
  });
});
