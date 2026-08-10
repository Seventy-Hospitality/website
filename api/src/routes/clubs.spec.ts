import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { SessionExpiredError } from '@/lib/contexts/identity';
import {
  CannotRemoveClubOwnerError,
  ClubInvitationNotFoundError,
  ClubNotFoundError,
  ClubPermissionError,
  ClubValidationError,
  InviteLinkInvalidError,
  OwnerMustTransferFirstError,
} from '@/lib/contexts/clubs';
import { MediaValidationError } from '@/lib/contexts/media';

const { mockClubService, mockReservationService, mockSessionService } = vi.hoisted(() => ({
  mockClubService: {
    listForMember: vi.fn().mockResolvedValue([]),
    listMyInvitations: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    getForViewer: vi.fn(),
    update: vi.fn(),
    setCoverImage: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    listMembers: vi.fn().mockResolvedValue([]),
    changeMemberRole: vi.fn().mockResolvedValue(undefined),
    removeMember: vi.fn().mockResolvedValue(undefined),
    invite: vi.fn(),
    respondToInvitation: vi.fn(),
    createInviteLink: vi.fn(),
    previewInviteLink: vi.fn(),
    joinViaLink: vi.fn(),
    assertMember: vi.fn().mockResolvedValue(undefined),
  },
  mockReservationService: { listForClub: vi.fn().mockResolvedValue([]) },
  mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
}));

vi.mock('@/lib/container', () => ({
  clubService: mockClubService,
  reservationService: mockReservationService,
  sessionService: mockSessionService,
  membershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
  VENUE_TIMEZONE: 'America/New_York',
}));

import { buildTestApp } from '@/src/test/app';
import { clubRoutes } from './clubs';

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

function clubSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clb_1',
    name: 'baddies',
    description: null,
    coverImageUrl: null,
    memberCount: 3,
    ...overrides,
  };
}

/** Hand-rolled multipart body for the cover upload. */
function multipartUpload(field: string, filename: string, contentType: string, bytes: Buffer) {
  const boundary = '----clubcover';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('club routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    mockClubService.listForMember.mockResolvedValue([]);
    mockClubService.listMyInvitations.mockResolvedValue([]);
    mockClubService.listMembers.mockResolvedValue([]);
    mockClubService.assertMember.mockResolvedValue(undefined);
    mockReservationService.listForClub.mockResolvedValue([]);
    app = await buildTestApp({
      routes: async (instance) => {
        await instance.register(multipart);
        await clubRoutes(instance);
      },
      prefix: '/api',
    });
  });

  afterEach(() => app.close());

  describe('policies', () => {
    it('requires a session on every club surface', async () => {
      for (const [method, url] of [
        ['GET', '/api/me/clubs'],
        ['GET', '/api/me/club-invitations'],
        ['POST', '/api/clubs'],
        ['GET', '/api/clubs/clb_1'],
        ['POST', '/api/clubs/join'],
      ] as const) {
        const res = await app.inject({ method, url });
        expect(res.statusCode).toBe(401);
      }
    });

    it('requires a member profile', async () => {
      signedInAs({ memberId: null });
      const res = await app.inject({ method: 'GET', url: '/api/me/clubs', headers: AUTH });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/me/clubs', () => {
    it('lists my clubs with role and member count', async () => {
      signedInAs();
      mockClubService.listForMember.mockResolvedValue([
        {
          ...clubSummary(),
          myRole: 'owner',
          joinedAt: new Date('2026-08-01T00:00:00Z'),
          createdAt: new Date('2026-08-01T00:00:00Z'),
        },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/me/clubs', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockClubService.listForMember).toHaveBeenCalledWith('mem_1');
      expect(res.json().data[0]).toMatchObject({ id: 'clb_1', myRole: 'owner', memberCount: 3 });
    });
  });

  describe('POST /api/clubs', () => {
    it('creates a club with initial invitees', async () => {
      signedInAs();
      mockClubService.create.mockResolvedValue({ club: clubSummary({ memberCount: 1 }), invited: ['mem_2'] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs',
        headers: AUTH,
        payload: { name: 'baddies', inviteeMemberIds: ['mem_2'] },
      });

      expect(res.statusCode).toBe(201);
      expect(mockClubService.create).toHaveBeenCalledWith(
        { name: 'baddies', description: undefined, inviteeMemberIds: ['mem_2'] },
        { memberId: 'mem_1', actorId: 'usr_1' },
      );
      expect(res.json().data.invited).toEqual(['mem_2']);
    });

    it('requires a name', async () => {
      signedInAs();
      const res = await app.inject({ method: 'POST', url: '/api/clubs', headers: AUTH, payload: {} });
      expect(res.statusCode).toBe(400);
      expect(mockClubService.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/clubs/:id (IDOR shape)', () => {
    it('serves detail with permission flags to a club member', async () => {
      signedInAs();
      mockClubService.getForViewer.mockResolvedValue({
        ...clubSummary(),
        myRole: 'member',
        permissions: {
          canEdit: false,
          canDelete: false,
          canManageMembers: false,
          canInvite: true,
          canLeave: true,
        },
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      });

      const res = await app.inject({ method: 'GET', url: '/api/clubs/clb_1', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.permissions.canInvite).toBe(true);
    });

    it('answers 404 for a non-member, indistinguishable from a missing club', async () => {
      signedInAs();
      mockClubService.getForViewer.mockRejectedValue(new ClubNotFoundError('clb_1'));

      const res = await app.inject({ method: 'GET', url: '/api/clubs/clb_1', headers: AUTH });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });
  });

  describe('owner-only actions answer 403 for members', () => {
    it('PATCH /api/clubs/:id', async () => {
      signedInAs();
      mockClubService.update.mockRejectedValue(new ClubPermissionError());
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/clubs/clb_1',
        headers: AUTH,
        payload: { name: 'renamed' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('DELETE /api/clubs/:id', async () => {
      signedInAs();
      mockClubService.delete.mockRejectedValue(new ClubPermissionError());
      const res = await app.inject({ method: 'DELETE', url: '/api/clubs/clb_1', headers: AUTH });
      expect(res.statusCode).toBe(403);
    });

    it('PATCH /api/clubs/:id/members/:memberId (role change)', async () => {
      signedInAs();
      mockClubService.changeMemberRole.mockRejectedValue(new ClubPermissionError());
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/clubs/clb_1/members/mem_2',
        headers: AUTH,
        payload: { role: 'owner' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('DELETE /api/clubs/:id/members/:memberId', async () => {
      signedInAs();
      mockClubService.removeMember.mockRejectedValue(new ClubPermissionError());
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/clubs/clb_1/members/mem_2',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('membership rules', () => {
    it('maps owner-must-transfer on leave to 409', async () => {
      signedInAs();
      mockClubService.leave.mockRejectedValue(new OwnerMustTransferFirstError());
      const res = await app.inject({ method: 'POST', url: '/api/clubs/clb_1/leave', headers: AUTH });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('OWNER_MUST_TRANSFER');
    });

    it('maps removing the owner to 409', async () => {
      signedInAs();
      mockClubService.removeMember.mockRejectedValue(new CannotRemoveClubOwnerError());
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/clubs/clb_1/members/mem_1',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CANNOT_REMOVE_OWNER');
    });

    it('serves the roster with public member ids', async () => {
      signedInAs();
      mockClubService.listMembers.mockResolvedValue([
        {
          memberId: 'mem_1',
          firstName: 'Alice',
          lastName: 'Chen',
          role: 'owner',
          joinedAt: new Date('2026-08-01T00:00:00Z'),
        },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/clubs/clb_1/members', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().data[0]).toMatchObject({ memberId: 'mem_1', role: 'owner' });
    });
  });

  describe('invitations', () => {
    it('batch-invites through the service', async () => {
      signedInAs();
      mockClubService.invite.mockResolvedValue({ invited: ['mem_2'] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs/clb_1/invitations',
        headers: AUTH,
        payload: { memberIds: ['mem_2'] },
      });

      expect(res.statusCode).toBe(201);
      expect(mockClubService.invite).toHaveBeenCalledWith(
        'clb_1',
        { memberId: 'mem_1', actorId: 'usr_1' },
        ['mem_2'],
      );
    });

    it('lists my pending invitations', async () => {
      signedInAs();
      mockClubService.listMyInvitations.mockResolvedValue([
        {
          id: 'inv_1',
          club: clubSummary(),
          invitedBy: { memberId: 'mem_9', firstName: 'Bo', lastName: 'Li' },
          createdAt: new Date('2026-08-01T00:00:00Z'),
        },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/me/club-invitations', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().data[0].club.name).toBe('baddies');
    });

    it('responds through the service; only the invitee ever finds the invitation', async () => {
      signedInAs();
      mockClubService.respondToInvitation.mockRejectedValue(new ClubInvitationNotFoundError('inv_1'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/club-invitations/inv_1/respond',
        headers: AUTH,
        payload: { response: 'accept' },
      });

      expect(res.statusCode).toBe(404);
      expect(mockClubService.respondToInvitation).toHaveBeenCalledWith(
        'inv_1',
        { memberId: 'mem_1', actorId: 'usr_1' },
        'accept',
      );
    });

    it('validates the response verb', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'POST',
        url: '/api/club-invitations/inv_1/respond',
        headers: AUTH,
        payload: { response: 'maybe' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('invite links', () => {
    it('mints a link and returns the raw token once', async () => {
      signedInAs();
      mockClubService.createInviteLink.mockResolvedValue({
        token: 'raw-token',
        expiresAt: new Date('2026-09-09T12:00:00Z'),
        maxUses: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs/clb_1/invite-link',
        headers: AUTH,
        payload: {},
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().data).toEqual({
        token: 'raw-token',
        expiresAt: '2026-09-09T12:00:00.000Z',
        maxUses: null,
      });
    });

    it('maps a member trying to rotate to 403', async () => {
      signedInAs();
      mockClubService.createInviteLink.mockRejectedValue(
        new ClubPermissionError('Only the club owner can revoke existing invite links'),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs/clb_1/invite-link',
        headers: AUTH,
        payload: { rotate: true },
      });
      expect(res.statusCode).toBe(403);
    });

    it('previews a link', async () => {
      signedInAs();
      mockClubService.previewInviteLink.mockResolvedValue({
        club: clubSummary(),
        alreadyMember: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs/invite-preview',
        headers: AUTH,
        payload: { token: 'raw-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.club.id).toBe('clb_1');
    });

    it('joins via link', async () => {
      signedInAs();
      mockClubService.joinViaLink.mockResolvedValue({
        club: clubSummary(),
        joined: true,
        alreadyMember: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs/join',
        headers: AUTH,
        payload: { token: 'raw-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.joined).toBe(true);
    });

    it('rejects a revoked or expired link with 410', async () => {
      signedInAs();
      for (const reason of ['revoked', 'expired', 'exhausted', 'invalid'] as const) {
        mockClubService.joinViaLink.mockRejectedValue(new InviteLinkInvalidError(reason));
        const res = await app.inject({
          method: 'POST',
          url: '/api/clubs/join',
          headers: AUTH,
          payload: { token: 'raw-token' },
        });
        expect(res.statusCode).toBe(410);
        expect(res.json().error.code).toBe('INVITE_LINK_INVALID');
      }
    });
  });

  describe('GET /api/clubs/:id/activity', () => {
    it('gates on club membership before reading reservations', async () => {
      signedInAs();
      mockClubService.assertMember.mockRejectedValue(new ClubNotFoundError('clb_1'));

      const res = await app.inject({ method: 'GET', url: '/api/clubs/clb_1/activity', headers: AUTH });

      expect(res.statusCode).toBe(404);
      expect(mockReservationService.listForClub).not.toHaveBeenCalled();
    });

    it('serves upcoming club-linked reservations by default', async () => {
      signedInAs();
      mockReservationService.listForClub.mockResolvedValue([
        {
          id: 'rsv_1',
          reference: 'BK-001000',
          resourceTypeId: 'rt_1',
          resourceId: 'crt_1',
          organizerId: 'mem_1',
          clubId: 'clb_1',
          seriesId: null,
          startsAt: new Date('2026-09-01T22:00:00.000Z'),
          endsAt: new Date('2026-09-01T23:00:00.000Z'),
          localDate: '2026-09-01',
          status: 'confirmed',
          hourlyRateCentsSnapshot: 2000,
          amountPaidCents: 2000,
          cancelRefundPercent: null,
          createdByAdminId: null,
          createdAt: new Date('2026-08-01T00:00:00Z'),
          updatedAt: new Date('2026-08-01T00:00:00Z'),
          resourceType: { id: 'rt_1', code: 'badminton_court', name: 'Badminton Court' },
          resource: { id: 'crt_1', name: 'Court 1' },
          participants: [],
          payments: [],
          claim: null,
          pendingChange: null,
        },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/clubs/clb_1/activity', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockClubService.assertMember).toHaveBeenCalledWith('clb_1', 'mem_1');
      expect(mockReservationService.listForClub).toHaveBeenCalledWith('clb_1', 'upcoming');
      expect(res.json().data[0]).toMatchObject({ id: 'rsv_1', clubId: 'clb_1' });
    });

    it('honors the past filter', async () => {
      signedInAs();
      await app.inject({ method: 'GET', url: '/api/clubs/clb_1/activity?filter=past', headers: AUTH });
      expect(mockReservationService.listForClub).toHaveBeenCalledWith('clb_1', 'past');
    });
  });

  describe('POST /api/clubs/:id/cover-image', () => {
    it('uploads a cover through the service (multipart happy path)', async () => {
      signedInAs();
      mockClubService.setCoverImage.mockResolvedValue(
        clubSummary({ coverImageUrl: '/uploads/event-images/cover.jpg' }),
      );

      const { payload, headers } = multipartUpload('file', 'cover.jpg', 'image/jpeg', Buffer.from('fake-image'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs/clb_1/cover-image',
        headers: { ...AUTH, ...headers },
        payload,
      });

      expect(res.statusCode).toBe(201);
      expect(mockClubService.setCoverImage).toHaveBeenCalledWith(
        'clb_1',
        { memberId: 'mem_1', actorId: 'usr_1' },
        expect.objectContaining({
          filename: 'cover.jpg',
          contentType: 'image/jpeg',
          bytes: Buffer.from('fake-image'),
        }),
      );
      expect(res.json().data.coverImageUrl).toBe('/uploads/event-images/cover.jpg');
    });

    it('rejects non-multipart requests with 415', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs/clb_1/cover-image',
        headers: AUTH,
        payload: { nope: true },
      });
      expect(res.statusCode).toBe(415);
    });

    it('maps media validation failures to 422', async () => {
      signedInAs();
      mockClubService.setCoverImage.mockRejectedValue(
        new MediaValidationError('Event images must be JPG, PNG, WebP, or GIF files'),
      );

      const { payload, headers } = multipartUpload('file', 'cover.txt', 'text/plain', Buffer.from('nope'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs/clb_1/cover-image',
        headers: { ...AUTH, ...headers },
        payload,
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVALID_IMAGE');
    });

    it('is owner-only through the service', async () => {
      signedInAs();
      mockClubService.setCoverImage.mockRejectedValue(new ClubPermissionError());

      const { payload, headers } = multipartUpload('file', 'cover.jpg', 'image/jpeg', Buffer.from('img'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs/clb_1/cover-image',
        headers: { ...AUTH, ...headers },
        payload,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('validation failures', () => {
    it('rejects an invalid club update', async () => {
      signedInAs();
      mockClubService.update.mockRejectedValue(new ClubValidationError('Club name is required'));
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/clubs/clb_1',
        headers: AUTH,
        payload: { name: 'x' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVALID_CLUB');
    });

    it('rejects an empty invitation batch', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'POST',
        url: '/api/clubs/clb_1/invitations',
        headers: AUTH,
        payload: { memberIds: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(mockClubService.invite).not.toHaveBeenCalled();
    });
  });
});
