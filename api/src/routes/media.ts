import type { FastifyInstance, FastifyReply } from 'fastify';
import { mediaService } from '@/lib/container';
import {
  MEDIA_USAGE_SPECS,
  MediaValidationError,
} from '@/lib/contexts/media';
import { error, success } from '@/src/lib/responses';
import { deleteManagedImageSchema } from '@/src/lib/validation';

export async function mediaRoutes(app: FastifyInstance) {
  app.post('/event-images', { config: { policy: 'admin' } }, async (req, reply) => {
    if (!req.isMultipart()) {
      return error(reply, 'INVALID_CONTENT_TYPE', 'Expected multipart form upload', 415);
    }

    try {
      const file = await req.file({
        limits: {
          files: 1,
          fileSize: MEDIA_USAGE_SPECS['event-image'].maxUploadBytes,
        },
      });

      if (!file) {
        return error(reply, 'VALIDATION_ERROR', 'Image file is required');
      }

      const bytes = await file.toBuffer();
      const asset = await mediaService.upload('event-image', {
        filename: file.filename,
        contentType: file.mimetype,
        bytes,
      });

      void mediaService.cleanupStaleAssets({
        maxAgeHours: Number(process.env.MEDIA_STALE_UPLOAD_MAX_AGE_HOURS ?? 24),
        limit: Number(process.env.MEDIA_STALE_UPLOAD_CLEANUP_LIMIT ?? 10),
      }).catch((cleanupError) => {
        req.log.warn({ err: cleanupError }, 'Failed to clean up stale media assets after upload');
      });

      return success(reply, { imageUrl: asset.publicUrl }, 201);
    } catch (uploadError) {
      return handleMediaError(app, reply, uploadError);
    }
  });

  app.delete('/event-images', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = deleteManagedImageSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(reply, 'VALIDATION_ERROR', parsed.error.message);
    }

    // Usage-pinned: this admin endpoint can only ever delete event images,
    // never an avatar or a private ID photo whose path leaked.
    await mediaService.deleteAsset(parsed.data.imageUrl, { expectUsage: 'event-image' });
    return success(reply, { deleted: true });
  });
}

function handleMediaError(app: FastifyInstance, reply: FastifyReply, uploadError: unknown) {
  if (uploadError instanceof app.multipartErrors.RequestFileTooLargeError) {
    return error(reply, 'FILE_TOO_LARGE', MEDIA_USAGE_SPECS['event-image'].tooLargeMessage, 413);
  }

  if (uploadError instanceof app.multipartErrors.FilesLimitError) {
    return error(reply, 'VALIDATION_ERROR', 'Upload exactly one image file');
  }

  if (uploadError instanceof MediaValidationError) {
    return error(reply, 'INVALID_IMAGE', uploadError.message, 422);
  }

  throw uploadError;
}
