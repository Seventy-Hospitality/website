import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  accountDeletionService,
  memberAvatarService,
  memberQrService,
  notificationSettingsService,
  stepUpService,
} from '@/lib/container';
import { AccountClosureBlockedError } from '@/lib/contexts/billing';
import { StepUpFailedError, type StepUpProof } from '@/lib/contexts/identity';
import { MEDIA_USAGE_SPECS, MediaValidationError } from '@/lib/contexts/media';
import { MemberNotFoundError } from '@/lib/contexts/members';
import { error, success } from '@/src/lib/responses';
import { perUserRateLimit } from '@/src/lib/user-rate-limit';
import { deleteAccountSchema, registerDeviceSchema, updatePreferencesSchema } from '@/src/lib/validation';

function memberId(req: FastifyRequest): string {
  return req.principal!.memberId!;
}

/** Maps the request body to exactly one step-up proof, favoring password. */
function toStepUpProof(body: {
  password?: string;
  provider?: 'google' | 'apple';
  idToken?: string;
  nonce?: string;
  reauthToken?: string;
}): StepUpProof | null {
  if (body.password) return { kind: 'password', password: body.password };
  if (body.provider && body.idToken && body.nonce) {
    return { kind: 'oauth', provider: body.provider, idToken: body.idToken, nonce: body.nonce };
  }
  if (body.reauthToken) return { kind: 'reauth_email', token: body.reauthToken };
  return null;
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

  // ── Account deletion (step-up gated, resumable saga) ──

  // Emails a single-use re-auth code (subject- and session-bound): the
  // step-up path for accounts with neither a password nor a reachable
  // OAuth provider. Tightly limited per USER (an email bomb otherwise).
  app.post(
    '/reauth-email',
    {
      config: { policy: 'authenticated' },
      preHandler: perUserRateLimit(3, 15 * 60_000),
    },
    async (req, reply) => {
      await stepUpService.sendReauthEmail(req.principal!);
      return success(reply, { sent: true }, 202);
    },
  );

  // Policy `authenticated`, not `member`: an account that never finished
  // onboarding must still be deletable. Step-up proof is required to START
  // a deletion; an existing request resumes without new proof (its
  // creation already carried it, and later steps revoke the credentials
  // the proof would need). Rate-limited per USER: the password branch is
  // an online guessing oracle against a known account.
  app.delete(
    '/',
    {
      config: { policy: 'authenticated' },
      preHandler: perUserRateLimit(5, 15 * 60_000),
    },
    async (req, reply) => {
      const principal = req.principal!;
      const existing = await accountDeletionService.getForUser(principal.userId);

      let stepUpMethod = existing?.stepUpMethod;
      if (!existing) {
        const parsed = deleteAccountSchema.safeParse(req.body ?? {});
        if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

        const proof = toStepUpProof(parsed.data);
        if (!proof) {
          return error(
            reply,
            'STEP_UP_REQUIRED',
            'Confirm your identity to delete this account',
            403,
            { acceptableMethods: await stepUpService.acceptableMethods(principal.userId) },
          );
        }
        try {
          stepUpMethod = await stepUpService.verify(principal, proof);
        } catch (err) {
          if (err instanceof StepUpFailedError) {
            return error(reply, 'STEP_UP_FAILED', 'Re-authentication failed', 403);
          }
          throw err;
        }
      }

      try {
        const outcome = await accountDeletionService.request({
          userId: principal.userId,
          memberId: principal.memberId,
          sessionId: principal.sessionId,
          email: principal.email,
          stepUpMethod: stepUpMethod!,
          client: principal.client,
          ip: req.ip,
        });
        if (outcome.status === 'blocked') {
          return error(reply, 'DELETION_BLOCKED', 'Account deletion is blocked', 409, {
            reasons: outcome.blockedReasons ?? [],
          });
        }
        // completed | failed (retry scheduled) | in_progress: the client
        // signs out locally either way; the saga finishes server-side.
        return success(reply, { status: outcome.status }, 202);
      } catch (err) {
        if (err instanceof AccountClosureBlockedError) {
          return error(reply, 'DELETION_BLOCKED', err.message, 409, { reasons: err.reasons });
        }
        throw err;
      }
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
