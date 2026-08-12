import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { idVerificationService } from '@/lib/container';
import { MEDIA_USAGE_SPECS, MediaValidationError } from '@/lib/contexts/media';
import { IdVerificationStateError, type IdVerificationStatusView } from '@/lib/contexts/members';
import { error, success } from '@/src/lib/responses';
import { idVerificationQueueQuerySchema, idVerificationReviewSchema } from '@/src/lib/validation';

function memberId(req: FastifyRequest): string {
  return req.principal!.memberId!;
}

function serializeStatus(view: IdVerificationStatusView) {
  return {
    status: view.status,
    hasPhoto: view.hasPhoto,
    skippedAt: view.skippedAt?.toISOString() ?? null,
    submittedAt: view.submittedAt?.toISOString() ?? null,
    reviewedAt: view.reviewedAt?.toISOString() ?? null,
    note: view.note,
  };
}

function handleStateError(reply: FastifyReply, err: unknown) {
  if (err instanceof IdVerificationStateError) {
    return error(reply, 'ID_VERIFICATION_STATE', err.message, 409);
  }
  throw err;
}

/** Member self-service (registered under /api/me). */
export async function meIdVerificationRoutes(app: FastifyInstance) {
  app.get('/id-verification', { config: { policy: 'member' } }, async (req, reply) => {
    return success(reply, serializeStatus(await idVerificationService.getStatus(memberId(req))));
  });

  // Government-ID upload: PRIVATE storage (encrypted at rest, never the
  // public /uploads path), replaceable until submitted.
  app.post('/id-verification/photo', { config: { policy: 'member' } }, async (req, reply) => {
    if (!req.isMultipart()) {
      return error(reply, 'INVALID_CONTENT_TYPE', 'Expected multipart form upload', 415);
    }

    try {
      const file = await req.file({
        limits: { files: 1, fileSize: MEDIA_USAGE_SPECS['id-photo'].maxUploadBytes },
      });
      if (!file) return error(reply, 'VALIDATION_ERROR', 'Photo file is required');

      const bytes = await file.toBuffer();
      const view = await idVerificationService.uploadPhoto(memberId(req), {
        filename: file.filename,
        contentType: file.mimetype,
        bytes,
      });
      return success(reply, serializeStatus(view), 201);
    } catch (err) {
      if (err instanceof app.multipartErrors.RequestFileTooLargeError) {
        return error(reply, 'FILE_TOO_LARGE', MEDIA_USAGE_SPECS['id-photo'].tooLargeMessage, 413);
      }
      if (err instanceof app.multipartErrors.FilesLimitError) {
        return error(reply, 'VALIDATION_ERROR', 'Upload exactly one photo');
      }
      if (err instanceof MediaValidationError) {
        return error(reply, 'INVALID_IMAGE', err.message, 422);
      }
      return handleStateError(reply, err);
    }
  });

  app.post('/id-verification/submit', { config: { policy: 'member' } }, async (req, reply) => {
    try {
      return success(reply, serializeStatus(await idVerificationService.submit(memberId(req))));
    } catch (err) {
      return handleStateError(reply, err);
    }
  });

  app.post('/id-verification/skip', { config: { policy: 'member' } }, async (req, reply) => {
    try {
      return success(reply, serializeStatus(await idVerificationService.skip(memberId(req))));
    } catch (err) {
      return handleStateError(reply, err);
    }
  });
}

/** Staff review surface (registered under /api). */
export async function idVerificationReviewRoutes(app: FastifyInstance) {
  app.get('/id-verifications', { config: { policy: 'staff' } }, async (req, reply) => {
    const parsed = idVerificationQueueQuerySchema.safeParse(req.query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const queue = await idVerificationService.listQueue(parsed.data.status);
    return success(
      reply,
      queue.map((row) => ({
        memberId: row.memberId,
        memberNumber: row.member.memberNumber,
        firstName: row.member.firstName,
        lastName: row.member.lastName,
        displayName: row.member.displayName,
        avatarUrl: row.member.avatarUrl,
        email: row.member.email,
        status: row.status,
        hasPhoto: row.imageAssetRef !== null,
        submittedAt: row.submittedAt?.toISOString() ?? null,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
      })),
    );
  });

  // The ONLY way a government-ID photo leaves the API: authenticated staff,
  // decrypted in memory, no-store, every view audited.
  app.get<{ Params: { memberId: string } }>(
    '/id-verifications/:memberId/photo',
    { config: { policy: 'staff' } },
    async (req, reply) => {
      const photo = await idVerificationService.readPhotoForStaff(req.params.memberId, req.principal!.userId);
      if (!photo) return error(reply, 'NOT_FOUND', 'No ID photo on file', 404);

      reply.type(photo.contentType);
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', `inline; filename="id-photo-${req.params.memberId}"`);
      if (photo.contentLength !== undefined) {
        reply.header('Content-Length', photo.contentLength);
      }
      return reply.send(photo.body);
    },
  );

  app.post<{ Params: { memberId: string } }>(
    '/id-verifications/:memberId/review',
    { config: { policy: 'staff' } },
    async (req, reply) => {
      const parsed = idVerificationReviewSchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const view = await idVerificationService.review(
          req.params.memberId,
          parsed.data.decision,
          req.principal!.userId,
          parsed.data.note ?? null,
        );
        return success(reply, serializeStatus(view));
      } catch (err) {
        return handleStateError(reply, err);
      }
    },
  );
}
