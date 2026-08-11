import type { FastifyInstance } from 'fastify';
import { SessionExpiredError } from '@/lib/contexts/identity';

const { mockMemberService, mockMembershipChecker, mockSessionService } = vi.hoisted(() => ({
  mockMemberService: {
    list: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    search: vi.fn().mockResolvedValue([]),
    browseDirectory: vi.fn().mockResolvedValue([]),
  },
  mockMembershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
  mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
}));

vi.mock('@/lib/container', () => ({
  memberService: mockMemberService,
  membershipChecker: mockMembershipChecker,
  sessionService: mockSessionService,
}));

import { buildTestApp } from '@/src/test/app';
import { memberRoutes } from './members';

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

describe('member directory search', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    app = await buildTestApp({ routes: memberRoutes, prefix: '/api/members' });
  });

  afterEach(() => app.close());

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/members/search?q=al' });
    expect(res.statusCode).toBe(401);
  });

  it('requires a member profile: staff without one cannot browse the directory', async () => {
    signedInAs({ memberId: null, staffRole: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/api/members/search?q=al', headers: AUTH });
    expect(res.statusCode).toBe(403);
    expect(mockMemberService.search).not.toHaveBeenCalled();
  });

  it('searches by name prefix and returns names only', async () => {
    signedInAs();
    mockMemberService.search.mockResolvedValue([{ id: 'mem_2', firstName: 'Bob', lastName: 'Park' }]);

    const res = await app.inject({ method: 'GET', url: '/api/members/search?q=bo', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(mockMemberService.search).toHaveBeenCalledWith('bo', 10, 0);
    expect(mockMemberService.browseDirectory).not.toHaveBeenCalled();
    expect(res.json().data).toEqual([{ id: 'mem_2', firstName: 'Bob', lastName: 'Park' }]);
  });

  it('pages search results', async () => {
    signedInAs();

    const res = await app.inject({
      method: 'GET',
      url: '/api/members/search?q=bo&limit=5&page=3',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(mockMemberService.search).toHaveBeenCalledWith('bo', 5, 10);
  });

  it('serves the default directory page (caller excluded) without a query', async () => {
    signedInAs();
    mockMemberService.browseDirectory.mockResolvedValue([
      { id: 'mem_2', firstName: 'Bob', lastName: 'Park' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/members/search', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(mockMemberService.browseDirectory).toHaveBeenCalledWith('mem_1', 10, 0);
    expect(mockMemberService.search).not.toHaveBeenCalled();
    expect(res.json().data).toEqual([{ id: 'mem_2', firstName: 'Bob', lastName: 'Park' }]);
  });

  it('treats an empty query as the directory page', async () => {
    signedInAs();

    const res = await app.inject({
      method: 'GET',
      url: '/api/members/search?q=&page=2&limit=25',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(mockMemberService.browseDirectory).toHaveBeenCalledWith('mem_1', 25, 25);
  });

  it('leaves the admin member list admin-only', async () => {
    signedInAs(); // plain member
    const res = await app.inject({ method: 'GET', url: '/api/members/', headers: AUTH });
    expect(res.statusCode).toBe(403);
  });
});
