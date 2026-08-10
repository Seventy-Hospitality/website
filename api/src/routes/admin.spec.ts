import type { FastifyInstance } from 'fastify';

const { mockUserRepo, mockSessionService, mockMembershipChecker } = vi.hoisted(() => ({
  mockUserRepo: {
    listAdmins: vi.fn().mockResolvedValue([]),
    findByEmail: vi.fn(),
    create: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
  mockMembershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
}));

vi.mock('@/lib/container', () => ({
  userRepo: mockUserRepo,
  sessionService: mockSessionService,
  membershipChecker: mockMembershipChecker,
}));

import { buildTestApp } from '@/src/test/app';
import { adminRoutes } from './admin';

function signedInAsAdmin() {
  mockSessionService.validateAccessToken.mockResolvedValue({
    userId: 'usr_admin',
    sessionId: 'ses_1',
    email: 'boss@club70.nyc',
    emailVerified: true,
    staffRole: 'admin',
    memberId: null,
    client: 'admin_web',
  });
}

describe('admin routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.refresh.mockRejectedValue(new Error('no refresh'));
    signedInAsAdmin();
    app = await buildTestApp({ routes: adminRoutes, prefix: '/api/admin' });
  });

  afterEach(() => app.close());

  describe('POST /api/admin/users', () => {
    it('normalizes the email before the duplicate check and the write', async () => {
      mockUserRepo.findByEmail.mockResolvedValue(null);
      mockUserRepo.create.mockResolvedValue({ id: 'usr_1', email: 'ops@club70.nyc', name: 'Ops', role: 'admin' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: { authorization: 'Bearer admin_jwt' },
        payload: { email: '  Ops@Club70.NYC ', name: 'Ops' },
      });

      expect(res.statusCode).toBe(200);
      // Both the lookup and the write see the normalized address, so the row can
      // be found later by every identity path (magic link, sign-in, reset).
      expect(mockUserRepo.findByEmail).toHaveBeenCalledWith('ops@club70.nyc');
      expect(mockUserRepo.create).toHaveBeenCalledWith('ops@club70.nyc', 'Ops', 'admin');
    });

    it('detects a case-only duplicate as a conflict', async () => {
      mockUserRepo.findByEmail.mockResolvedValue({ id: 'usr_1', email: 'ops@club70.nyc', name: 'Ops', role: 'admin' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: { authorization: 'Bearer admin_jwt' },
        payload: { email: 'OPS@club70.nyc', name: 'Ops' },
      });

      expect(res.statusCode).toBe(409);
      expect(mockUserRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a malformed email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: { authorization: 'Bearer admin_jwt' },
        payload: { email: 'not-an-email', name: 'Ops' },
      });

      expect(res.statusCode).toBe(400);
      expect(mockUserRepo.create).not.toHaveBeenCalled();
    });

    it('refuses a non-admin caller', async () => {
      mockSessionService.validateAccessToken.mockResolvedValue({
        userId: 'usr_2',
        sessionId: 'ses_2',
        email: 'member@club70.nyc',
        emailVerified: true,
        staffRole: null,
        memberId: 'mem_2',
        client: 'member_mobile',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: { authorization: 'Bearer member_jwt' },
        payload: { email: 'ops@club70.nyc', name: 'Ops' },
      });

      expect(res.statusCode).toBe(403);
      expect(mockUserRepo.create).not.toHaveBeenCalled();
    });
  });
});
