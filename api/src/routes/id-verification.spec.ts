import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Readable } from 'node:stream';
import { SessionExpiredError } from '@/lib/contexts/identity';
import { IdVerificationStateError } from '@/lib/contexts/members';

const { mockIdVerificationService, mockMembershipChecker, mockSessionService } = vi.hoisted(() => ({
  mockIdVerificationService: {
    getStatus: vi.fn(),
    uploadPhoto: vi.fn(),
    submit: vi.fn(),
    skip: vi.fn(),
    listQueue: vi.fn(),
    readPhotoForStaff: vi.fn(),
    review: vi.fn(),
  },
  mockMembershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
  mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
}));

vi.mock('@/lib/container', () => ({
  idVerificationService: mockIdVerificationService,
  membershipChecker: mockMembershipChecker,
  sessionService: mockSessionService,
}));

import { buildTestApp } from '@/src/test/app';
import { idVerificationReviewRoutes, meIdVerificationRoutes } from './id-verification';

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

const STATUS_VIEW = {
  status: 'not_submitted',
  hasPhoto: false,
  skippedAt: null,
  submittedAt: null,
  reviewedAt: null,
  note: null,
};

function multipartUpload(filename: string, contentType: string, bytes: Buffer) {
  const boundary = '----idphoto';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('id-verification routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    mockIdVerificationService.getStatus.mockResolvedValue(STATUS_VIEW);
    mockIdVerificationService.listQueue.mockResolvedValue([]);
    app = await buildTestApp(
      {
        routes: async (instance) => {
          await instance.register(multipart);
          await meIdVerificationRoutes(instance);
        },
        prefix: '/api/me',
      },
      { routes: idVerificationReviewRoutes, prefix: '/api' },
    );
  });

  afterEach(() => app.close());

  describe('policies', () => {
    it('requires a member session on the self-service surface', async () => {
      for (const [method, url] of [
        ['GET', '/api/me/id-verification'],
        ['POST', '/api/me/id-verification/photo'],
        ['POST', '/api/me/id-verification/submit'],
        ['POST', '/api/me/id-verification/skip'],
      ] as const) {
        const res = await app.inject({ method, url });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    });

    it('keeps the review surface staff-only: a member gets 403 everywhere', async () => {
      signedInAs(); // plain member
      for (const [method, url] of [
        ['GET', '/api/id-verifications'],
        ['GET', '/api/id-verifications/mem_2/photo'],
        ['POST', '/api/id-verifications/mem_2/review'],
      ] as const) {
        const res = await app.inject({
          method,
          url,
          headers: AUTH,
          ...(method === 'POST' ? { payload: { decision: 'approve' } } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
      // A member can NEVER fetch anyone's ID photo, their own included:
      // the photo leaves the API only through the staff review surface.
      expect(mockIdVerificationService.readPhotoForStaff).not.toHaveBeenCalled();
    });
  });

  describe('member self-service', () => {
    it('serves the status view', async () => {
      signedInAs();
      const res = await app.inject({ method: 'GET', url: '/api/me/id-verification', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(mockIdVerificationService.getStatus).toHaveBeenCalledWith('mem_1');
      expect(res.json().data).toMatchObject({ status: 'not_submitted', hasPhoto: false });
    });

    it('uploads the photo for the principal member only', async () => {
      signedInAs();
      mockIdVerificationService.uploadPhoto.mockResolvedValue({ ...STATUS_VIEW, hasPhoto: true });

      const upload = multipartUpload('id.jpg', 'image/jpeg', Buffer.from('img'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/id-verification/photo',
        headers: { ...AUTH, ...upload.headers },
        payload: upload.payload,
      });

      expect(res.statusCode).toBe(201);
      expect(mockIdVerificationService.uploadPhoto).toHaveBeenCalledWith(
        'mem_1',
        expect.objectContaining({ filename: 'id.jpg', contentType: 'image/jpeg' }),
      );
      // The response never carries the private storage path.
      expect(JSON.stringify(res.json())).not.toContain('private/');
    });

    it('maps state-machine violations to 409', async () => {
      signedInAs();
      mockIdVerificationService.submit.mockRejectedValue(new IdVerificationStateError('Upload a photo of your ID before submitting'));
      const res = await app.inject({ method: 'POST', url: '/api/me/id-verification/submit', headers: AUTH });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ID_VERIFICATION_STATE');
    });

    it('records a skip', async () => {
      signedInAs();
      mockIdVerificationService.skip.mockResolvedValue({ ...STATUS_VIEW, skippedAt: new Date() });
      const res = await app.inject({ method: 'POST', url: '/api/me/id-verification/skip', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(mockIdVerificationService.skip).toHaveBeenCalledWith('mem_1');
    });
  });

  describe('staff review surface', () => {
    const asStaff = () => signedInAs({ staffRole: 'staff', memberId: null });

    it('serves the submitted queue with member identity', async () => {
      asStaff();
      mockIdVerificationService.listQueue.mockResolvedValue([
        {
          id: 'idv_1',
          memberId: 'mem_2',
          status: 'submitted',
          imageAssetRef: 'private/id-photos/photo1234567890123456.webp',
          skippedAt: null,
          submittedAt: new Date('2026-08-10T10:00:00Z'),
          reviewedAt: null,
          reviewedByAdminId: null,
          note: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          member: {
            id: 'mem_2',
            memberNumber: 'B23456',
            firstName: 'Bob',
            lastName: 'Park',
            displayName: null,
            avatarUrl: null,
            email: 'bob@example.com',
          },
        },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/id-verifications', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockIdVerificationService.listQueue).toHaveBeenCalledWith('submitted');
      expect(res.json().data[0]).toMatchObject({
        memberId: 'mem_2',
        memberNumber: 'B23456',
        hasPhoto: true,
        status: 'submitted',
      });
      // The private storage path stays inside the API.
      expect(JSON.stringify(res.json())).not.toContain('private/');
    });

    it('streams the photo with no-store headers through the audited service read', async () => {
      asStaff();
      mockIdVerificationService.readPhotoForStaff.mockResolvedValue({
        body: Readable.from(Buffer.from('jpeg-bytes')),
        contentType: 'image/jpeg',
        contentLength: 10,
      });

      const res = await app.inject({ method: 'GET', url: '/api/id-verifications/mem_2/photo', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockIdVerificationService.readPhotoForStaff).toHaveBeenCalledWith('mem_2', 'usr_1');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.rawPayload.toString()).toBe('jpeg-bytes');
    });

    it('404s when no photo is on file', async () => {
      asStaff();
      mockIdVerificationService.readPhotoForStaff.mockResolvedValue(null);
      const res = await app.inject({ method: 'GET', url: '/api/id-verifications/mem_2/photo', headers: AUTH });
      expect(res.statusCode).toBe(404);
    });

    it('reviews with a decision and optional note', async () => {
      asStaff();
      mockIdVerificationService.review.mockResolvedValue({ ...STATUS_VIEW, status: 'rejected', note: 'Blurry' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/id-verifications/mem_2/review',
        headers: AUTH,
        payload: { decision: 'reject', note: 'Blurry' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockIdVerificationService.review).toHaveBeenCalledWith('mem_2', 'reject', 'usr_1', 'Blurry');
    });

    it('rejects an unknown decision', async () => {
      asStaff();
      const res = await app.inject({
        method: 'POST',
        url: '/api/id-verifications/mem_2/review',
        headers: AUTH,
        payload: { decision: 'maybe' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('maps a review of a non-submitted row to 409', async () => {
      asStaff();
      mockIdVerificationService.review.mockRejectedValue(new IdVerificationStateError('Only a submitted ID can be reviewed'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/id-verifications/mem_2/review',
        headers: AUTH,
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(409);
    });
  });
});
