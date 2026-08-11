import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { SessionExpiredError } from '@/lib/contexts/identity';
import { MemberNotFoundError, QrTokenError } from '@/lib/contexts/members';

const {
  mockAvatarService,
  mockQrService,
  mockSettingsService,
  mockMembershipChecker,
  mockSessionService,
} = vi.hoisted(() => ({
  mockAvatarService: { updateAvatar: vi.fn(), removeAvatar: vi.fn() },
  mockQrService: { issue: vi.fn(), verify: vi.fn() },
  mockSettingsService: {
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    registerDevice: vi.fn(),
    unregisterDevice: vi.fn(),
  },
  mockMembershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
  mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
}));

vi.mock('@/lib/container', () => ({
  memberAvatarService: mockAvatarService,
  memberQrService: mockQrService,
  notificationSettingsService: mockSettingsService,
  membershipChecker: mockMembershipChecker,
  sessionService: mockSessionService,
}));

import { buildTestApp } from '@/src/test/app';
import { meAccountRoutes } from './me-account';

const AUTH = { authorization: 'Bearer access_jwt' } as const;

function signedInAs(overrides: Record<string, unknown> = {}) {
  mockSessionService.validateAccessToken.mockResolvedValue({
    userId: 'usr_1',
    sessionId: 'ses_1',
    email: 'alice@example.com',
    emailVerified: true,
    staffRole: null,
    memberId: 'mem_1',
    client: 'member_mobile',
    ...overrides,
  });
}

function multipartUpload(filename: string, contentType: string, bytes: Buffer) {
  const boundary = '----avatar';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('me-account routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    mockSettingsService.getPreferences.mockResolvedValue({
      pushNotifications: true,
      emailNotifications: true,
      bookingReminders: true,
    });
    mockSettingsService.updatePreferences.mockResolvedValue({
      pushNotifications: true,
      emailNotifications: false,
      bookingReminders: true,
    });
    mockSettingsService.registerDevice.mockResolvedValue({
      id: 'dev_1',
      memberId: 'mem_1',
      token: 'tok_1',
      platform: 'ios',
      createdAt: new Date('2026-08-11T00:00:00Z'),
      lastSeenAt: new Date('2026-08-11T00:00:00Z'),
    });
    mockSettingsService.unregisterDevice.mockResolvedValue(true);
    mockQrService.issue.mockResolvedValue({
      token: 'MQR1.payload.sig',
      expiresAt: new Date('2026-08-11T00:01:00Z'),
      ttlSeconds: 60,
    });
    app = await buildTestApp({
      routes: async (instance) => {
        await instance.register(multipart);
        await meAccountRoutes(instance);
      },
      prefix: '/api/me',
    });
  });

  afterEach(() => app.close());

  describe('policies', () => {
    it('requires a member session on every surface', async () => {
      for (const [method, url] of [
        ['POST', '/api/me/avatar'],
        ['DELETE', '/api/me/avatar'],
        ['GET', '/api/me/preferences'],
        ['PUT', '/api/me/preferences'],
        ['POST', '/api/me/devices'],
        ['DELETE', '/api/me/devices/tok_1'],
        ['GET', '/api/me/qr'],
      ] as const) {
        const res = await app.inject({ method, url });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    });

    it('403s an authenticated user without a member profile', async () => {
      signedInAs({ memberId: null });
      const res = await app.inject({ method: 'GET', url: '/api/me/qr', headers: AUTH });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /avatar', () => {
    it('uploads through the media pipeline for the principal member', async () => {
      signedInAs();
      mockAvatarService.updateAvatar.mockResolvedValue({ avatarUrl: '/uploads/avatars/new.webp' });

      const upload = multipartUpload('me.png', 'image/png', Buffer.from('png'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/avatar',
        headers: { ...AUTH, ...upload.headers },
        payload: upload.payload,
      });

      expect(res.statusCode).toBe(201);
      expect(mockAvatarService.updateAvatar).toHaveBeenCalledWith(
        'mem_1',
        expect.objectContaining({ filename: 'me.png', contentType: 'image/png' }),
      );
      expect(res.json().data).toEqual({ avatarUrl: '/uploads/avatars/new.webp' });
    });

    it('rejects non-multipart bodies', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/avatar',
        headers: AUTH,
        payload: { nope: true },
      });
      expect(res.statusCode).toBe(415);
    });
  });

  describe('preferences', () => {
    it('serves defaults and saves partial toggle updates independently', async () => {
      signedInAs();

      const get = await app.inject({ method: 'GET', url: '/api/me/preferences', headers: AUTH });
      expect(get.statusCode).toBe(200);
      expect(get.json().data).toEqual({
        pushNotifications: true,
        emailNotifications: true,
        bookingReminders: true,
      });

      const put = await app.inject({
        method: 'PUT',
        url: '/api/me/preferences',
        headers: AUTH,
        payload: { emailNotifications: false },
      });
      expect(put.statusCode).toBe(200);
      expect(mockSettingsService.updatePreferences).toHaveBeenCalledWith('mem_1', {
        emailNotifications: false,
      });
    });

    it('rejects non-boolean toggles', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/me/preferences',
        headers: AUTH,
        payload: { pushNotifications: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('devices', () => {
    it('registers a push token for the principal member', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/devices',
        headers: AUTH,
        payload: { token: 'tok_1', platform: 'ios' },
      });

      expect(res.statusCode).toBe(201);
      expect(mockSettingsService.registerDevice).toHaveBeenCalledWith('mem_1', 'tok_1', 'ios');
    });

    it('rejects unknown platforms', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/devices',
        headers: AUTH,
        payload: { token: 'tok_1', platform: 'windows_phone' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('unregisters only the caller-owned token (idempotent response)', async () => {
      signedInAs();
      mockSettingsService.unregisterDevice.mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/me/devices/tok_x', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockSettingsService.unregisterDevice).toHaveBeenCalledWith('mem_1', 'tok_x');
      expect(res.json().data).toEqual({ removed: false });
    });
  });

  describe('GET /qr', () => {
    it('serves a short-lived signed token, never the raw member id', async () => {
      signedInAs();
      const res = await app.inject({ method: 'GET', url: '/api/me/qr', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockQrService.issue).toHaveBeenCalledWith('mem_1');
      expect(res.json().data).toEqual({
        token: 'MQR1.payload.sig',
        expiresAt: '2026-08-11T00:01:00.000Z',
        ttlSeconds: 60,
      });
    });

    it('404s a deleted/vanished member profile', async () => {
      signedInAs();
      mockQrService.issue.mockRejectedValue(new MemberNotFoundError('mem_1'));
      const res = await app.inject({ method: 'GET', url: '/api/me/qr', headers: AUTH });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe('QR token errors surface as QrTokenError', () => {
  it('exposes the failure reason', () => {
    expect(new QrTokenError('expired').reason).toBe('expired');
  });
});
