import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  memberAvatarService,
  memberQrService,
  notificationSettingsService,
} from '@/lib/container';
import { MEDIA_USAGE_SPECS, MediaValidationError } from '@/lib/contexts/media';
import { MemberNotFoundError } from '@/lib/contexts/members';
import { error, success } from '@/src/lib/responses';
import { registerDeviceSchema, updatePreferencesSchema } from '@/src/lib/validation';

function memberId(req: FastifyRequest): string {
  return req.principal!.memberId!;
}

/**
 * Account-surface self-service: avatar, notification preferences, push
 * devices, member QR. Profile read/edit lives in me.ts next to the
 * historical /profile route.
 */
export async function meAccountRoutes(app: FastifyInstance) {
  // ── Avatar ──

  app.post('/avatar', { config: { policy: 'member' } }, async (req, reply) => {
    if (!req.isMultipart()) {
      return error(reply, 'INVALID_CONTENT_TYPE', 'Expected multipart form upload', 415);
    }

    try {
      const file = await req.file({
        limits: { files: 1, fileSize: MEDIA_USAGE_SPECS.avatar.maxUploadBytes },
      });
      if (!file) return error(reply, 'VALIDATION_ERROR', 'Image file is required');

      const bytes = await file.toBuffer();
      const { avatarUrl } = await memberAvatarService.updateAvatar(memberId(req), {
        filename: file.filename,
        contentType: file.mimetype,
        bytes,
      });
      return success(reply, { avatarUrl }, 201);
    } catch (err) {
      if (err instanceof app.multipartErrors.RequestFileTooLargeError) {
        return error(reply, 'FILE_TOO_LARGE', MEDIA_USAGE_SPECS.avatar.tooLargeMessage, 413);
      }
      if (err instanceof app.multipartErrors.FilesLimitError) {
        return error(reply, 'VALIDATION_ERROR', 'Upload exactly one image file');
      }
      if (err instanceof MediaValidationError) {
        return error(reply, 'INVALID_IMAGE', err.message, 422);
      }
      if (err instanceof MemberNotFoundError) {
        return error(reply, 'NOT_FOUND', err.message, 404);
      }
      throw err;
    }
  });

  app.delete('/avatar', { config: { policy: 'member' } }, async (req, reply) => {
    try {
      await memberAvatarService.removeAvatar(memberId(req));
      return success(reply, { avatarUrl: null });
    } catch (err) {
      if (err instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
      throw err;
    }
  });

  // ── Notification preferences (each toggle saved independently) ──

  app.get('/preferences', { config: { policy: 'member' } }, async (req, reply) => {
    return success(reply, await notificationSettingsService.getPreferences(memberId(req)));
  });

  app.put('/preferences', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = updatePreferencesSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    return success(reply, await notificationSettingsService.updatePreferences(memberId(req), parsed.data));
  });

  // ── Push devices (package F delivery targets) ──

  app.post('/devices', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = registerDeviceSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const device = await notificationSettingsService.registerDevice(
      memberId(req),
      parsed.data.token,
      parsed.data.platform,
    );
    return success(reply, { token: device.token, platform: device.platform, registeredAt: device.createdAt.toISOString() }, 201);
  });

  app.delete<{ Params: { token: string } }>(
    '/devices/:token',
    { config: { policy: 'member' } },
    async (req, reply) => {
      const removed = await notificationSettingsService.unregisterDevice(memberId(req), req.params.token);
      // Idempotent: unregistering an unknown (or someone else's) token is
      // indistinguishable from an already-removed one.
      return success(reply, { removed });
    },
  );

  // ── Member QR (short-lived signed token, never the raw member id) ──

  app.get(
    '/qr',
    { config: { policy: 'member', rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      try {
        const { token, expiresAt, ttlSeconds } = await memberQrService.issue(memberId(req));
        return success(reply, { token, expiresAt: expiresAt.toISOString(), ttlSeconds });
      } catch (err) {
        if (err instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
        throw err;
      }
    },
  );
}
