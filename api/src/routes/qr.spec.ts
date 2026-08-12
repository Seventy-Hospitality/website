import type { FastifyInstance } from 'fastify';
import { SessionExpiredError } from '@/lib/contexts/identity';
import { QrTokenError } from '@/lib/contexts/members';

const { mockQrService, mockMembershipChecker, mockSessionService } = vi.hoisted(() => ({
  mockQrService: { issue: vi.fn(), verify: vi.fn() },
  mockMembershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
  mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
}));

vi.mock('@/lib/container', () => ({
  memberQrService: mockQrService,
  membershipChecker: mockMembershipChecker,
  sessionService: mockSessionService,
}));

import { buildTestApp } from '@/src/test/app';
import { qrRoutes } from './qr';

const AUTH = { authorization: 'Bearer access_jwt' } as const;

function signedInAs(overrides: Record<string, unknown> = {}) {
  mockSessionService.validateAccessToken.mockResolvedValue({
    userId: 'usr_1',
    sessionId: 'ses_1',
    email: 'front-desk@seventy.club',
    emailVerified: true,
    staffRole: 'staff',
    memberId: null,
    client: 'admin_web',
    ...overrides,
  });
}

describe('qr routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    app = await buildTestApp({ routes: qrRoutes, prefix: '/api/qr' });
  });

  afterEach(() => app.close());

  describe('POST /verify', () => {
    it('requires a session', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/qr/verify', payload: { token: 'x' } });
      expect(res.statusCode).toBe(401);
    });

    it('is staff-only: a plain member cannot scan', async () => {
      signedInAs({ staffRole: null, memberId: 'mem_1' });
      const res = await app.inject({ method: 'POST', url: '/api/qr/verify', payload: { token: 'x' }, headers: AUTH });
      expect(res.statusCode).toBe(403);
      expect(mockQrService.verify).not.toHaveBeenCalled();
    });

    it('resolves a valid token to the member identity', async () => {
      signedInAs();
      mockQrService.verify.mockResolvedValue({
        memberId: 'mem_1',
        memberNumber: 'A12345',
        firstName: 'Alice',
        lastName: 'Chen',
        displayName: 'Alice Chen',
        avatarUrl: null,
        membershipStatus: 'active',
        expiresAt: new Date('2026-08-11T00:01:00Z'),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/qr/verify',
        payload: { token: 'MQR1.p.s' },
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        memberId: 'mem_1',
        memberNumber: 'A12345',
        membershipStatus: 'active',
      });
    });

    it('answers 410 for an expired token and an opaque 404 for tampered/unknown ones', async () => {
      signedInAs();

      mockQrService.verify.mockRejectedValue(new QrTokenError('expired'));
      const expired = await app.inject({ method: 'POST', url: '/api/qr/verify', payload: { token: 't' }, headers: AUTH });
      expect(expired.statusCode).toBe(410);
      expect(expired.json().error.code).toBe('QR_EXPIRED');

      for (const reason of ['tampered', 'malformed'] as const) {
        mockQrService.verify.mockRejectedValue(new QrTokenError(reason));
        const res = await app.inject({ method: 'POST', url: '/api/qr/verify', payload: { token: 't' }, headers: AUTH });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('QR_INVALID');
      }
    });
  });
});
