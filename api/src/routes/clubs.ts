import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clubService, reservationService, VENUE_TIMEZONE } from '@/lib/container';
import {
  CannotRemoveClubOwnerError,
  ClubInvitationNotFoundError,
  ClubInviteeNotFoundError,
  ClubMemberNotFoundError,
  ClubMustHaveOwnerError,
  ClubNotFoundError,
  ClubPermissionError,
  ClubValidationError,
  InvalidInvitationStateError,
  InviteLinkInvalidError,
  OwnerMustTransferFirstError,
  type ClubDetail,
  type ClubSummary,
  type MyClubItem,
  type PendingInvitationItem,
  type RosterEntry,
} from '@/lib/contexts/clubs';
import { MAX_EVENT_IMAGE_BYTES, MediaValidationError } from '@/lib/contexts/media';
import { error, success } from '@/src/lib/responses';
import { serializeClubActivityReservation } from '@/src/lib/reservations';
import {
  clubActivityQuerySchema,
  clubInvitationsSchema,
  clubInviteLinkSchema,
  clubMemberRoleSchema,
  clubTokenSchema,
  createClubSchema,
  respondClubInvitationSchema,
  updateClubSchema,
} from '@/src/lib/validation';

function memberId(req: FastifyRequest): string {
  return req.principal!.memberId!;
}

/** The acting principal for club audit events (B convention: the user id). */
function actor(req: FastifyRequest) {
  return { memberId: memberId(req), actorId: req.principal!.userId };
}

function serializeSummary(club: ClubSummary) {
  return {
    id: club.id,
    name: club.name,
    description: club.description,
    coverImageUrl: club.coverImageUrl,
    memberCount: club.memberCount,
  };
}

function serializeMyClub(item: MyClubItem) {
  return {
    ...serializeSummary(item),
    myRole: item.myRole,
    joinedAt: item.joinedAt.toISOString(),
    createdAt: item.createdAt.toISOString(),
  };
}

function serializeDetail(detail: ClubDetail) {
  return {
    ...serializeSummary(detail),
    myRole: detail.myRole,
    permissions: detail.permissions,
    createdAt: detail.createdAt.toISOString(),
    updatedAt: detail.updatedAt.toISOString(),
  };
}

function serializeRosterEntry(entry: RosterEntry) {
  return {
    memberId: entry.memberId,
    memberNumber: entry.memberNumber,
    firstName: entry.firstName,
    lastName: entry.lastName,
    displayName: entry.displayName,
    avatarUrl: entry.avatarUrl,
    role: entry.role,
    joinedAt: entry.joinedAt.toISOString(),
  };
}

function serializeInvitation(item: PendingInvitationItem) {
  return {
    id: item.id,
    club: serializeSummary(item.club),
    invitedBy: item.invitedBy,
    createdAt: item.createdAt.toISOString(),
  };
}

function handleClubError(reply: FastifyReply, err: unknown) {
  // Outsiders always see the 404 shape; role failures inside the club are
  // 403; state-machine conflicts are 409; a dead share link is 410.
  if (err instanceof ClubNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof ClubMemberNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof ClubInvitationNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof ClubPermissionError) return error(reply, 'FORBIDDEN', err.message, 403);
  if (err instanceof OwnerMustTransferFirstError) return error(reply, 'OWNER_MUST_TRANSFER', err.message, 409);
  if (err instanceof ClubMustHaveOwnerError) return error(reply, 'CLUB_NEEDS_OWNER', err.message, 409);
  if (err instanceof CannotRemoveClubOwnerError) return error(reply, 'CANNOT_REMOVE_OWNER', err.message, 409);
  if (err instanceof InvalidInvitationStateError) return error(reply, 'INVALID_INVITATION_STATE', err.message, 409);
  if (err instanceof InviteLinkInvalidError) return error(reply, 'INVITE_LINK_INVALID', err.message, 410);
  if (err instanceof ClubInviteeNotFoundError) return error(reply, 'INVITEE_NOT_FOUND', err.message, 404);
  if (err instanceof ClubValidationError) return error(reply, 'INVALID_CLUB', err.message, 422);
  throw err;
}

/**
 * Member-created social clubs. Every route rides the `member` policy; the
 * club-level authorization (outsider / member / owner) lives in the clubs
 * service, which answers 404-shaped for outsiders on every club id.
 */
export async function clubRoutes(app: FastifyInstance) {
  // ── My clubs ──

  app.get('/me/clubs', { config: { policy: 'member' } }, async (req, reply) => {
    const clubs = await clubService.listForMember(memberId(req));
    return success(reply, clubs.map(serializeMyClub));
  });

  app.get('/me/club-invitations', { config: { policy: 'member' } }, async (req, reply) => {
    const invitations = await clubService.listMyInvitations(memberId(req));
    return success(reply, invitations.map(serializeInvitation));
  });

  // ── Create ──

  app.post('/clubs', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = createClubSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const { club, invited } = await clubService.create(
        {
          name: parsed.data.name,
          description: parsed.data.description,
          inviteeMemberIds: parsed.data.inviteeMemberIds,
        },
        actor(req),
      );
      return success(reply, { club: serializeSummary(club), invited }, 201);
    } catch (err) {
      return handleClubError(reply, err);
    }
  });

  // ── Detail / edit / delete ──

  app.get<{ Params: { id: string } }>(
    '/clubs/:id',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        const detail = await clubService.getForViewer(req.params.id, memberId(req));
        return success(reply, serializeDetail(detail));
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/clubs/:id',
    { config: { policy: 'member' } },
    async (req, reply) => {
      const parsed = updateClubSchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const club = await clubService.update(req.params.id, actor(req), parsed.data);
        return success(reply, serializeSummary(club));
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/clubs/:id',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        await clubService.delete(req.params.id, actor(req));
        return success(reply, { deleted: true });
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );

  // ── Cover image (owner; media context's ManagedMediaAsset pipeline) ──

  app.post<{ Params: { id: string } }>(
    '/clubs/:id/cover-image',
    { config: { policy: 'member' } },
    async (req, reply) => {
      if (!req.isMultipart()) {
        return error(reply, 'INVALID_CONTENT_TYPE', 'Expected multipart form upload', 415);
      }

      try {
        const file = await req.file({ limits: { files: 1, fileSize: MAX_EVENT_IMAGE_BYTES } });
        if (!file) return error(reply, 'VALIDATION_ERROR', 'Image file is required');

        const bytes = await file.toBuffer();
        const club = await clubService.setCoverImage(req.params.id, actor(req), {
          filename: file.filename,
          contentType: file.mimetype,
          bytes,
        });
        return success(reply, serializeSummary(club), 201);
      } catch (err) {
        if (err instanceof app.multipartErrors.RequestFileTooLargeError) {
          return error(reply, 'FILE_TOO_LARGE', 'Cover images must be 5 MB or smaller', 413);
        }
        if (err instanceof app.multipartErrors.FilesLimitError) {
          return error(reply, 'VALIDATION_ERROR', 'Upload exactly one image file');
        }
        if (err instanceof MediaValidationError) {
          return error(reply, 'INVALID_IMAGE', err.message, 422);
        }
        return handleClubError(reply, err);
      }
    },
  );

  // ── Membership ──

  app.post<{ Params: { id: string } }>(
    '/clubs/:id/leave',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        await clubService.leave(req.params.id, actor(req));
        return success(reply, { left: true });
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/clubs/:id/members',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        const roster = await clubService.listMembers(req.params.id, memberId(req));
        return success(reply, roster.map(serializeRosterEntry));
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string; memberId: string } }>(
    '/clubs/:id/members/:memberId',
    { config: { policy: 'member' } },
    async (req, reply) => {
      const parsed = clubMemberRoleSchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        await clubService.changeMemberRole(
          req.params.id,
          actor(req),
          req.params.memberId,
          parsed.data.role,
        );
        return success(reply, { updated: true });
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; memberId: string } }>(
    '/clubs/:id/members/:memberId',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        await clubService.removeMember(req.params.id, actor(req), req.params.memberId);
        return success(reply, { removed: true });
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );

  // ── Invitations (require acceptance) ──

  app.post<{ Params: { id: string } }>(
    '/clubs/:id/invitations',
    { config: { policy: 'member' } },
    async (req, reply) => {
      const parsed = clubInvitationsSchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const result = await clubService.invite(req.params.id, actor(req), parsed.data.memberIds);
        return success(reply, result, 201);
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/club-invitations/:id/respond',
    { config: { policy: 'member' } },
    async (req, reply) => {
      const parsed = respondClubInvitationSchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const result = await clubService.respondToInvitation(
          req.params.id,
          actor(req),
          parsed.data.response,
        );
        return success(reply, result);
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );

  // ── Invite links (share link + QR) ──

  app.post<{ Params: { id: string } }>(
    '/clubs/:id/invite-link',
    { config: { policy: 'member' } },
    async (req, reply) => {
      const parsed = clubInviteLinkSchema.safeParse(req.body ?? {});
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const link = await clubService.createInviteLink(req.params.id, actor(req), parsed.data);
        // The raw token leaves the API exactly once, here; the client builds
        // the share URL and QR payload from it.
        return success(
          reply,
          {
            token: link.token,
            expiresAt: link.expiresAt?.toISOString() ?? null,
            maxUses: link.maxUses,
          },
          201,
        );
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );

  app.post('/clubs/invite-preview', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = clubTokenSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const preview = await clubService.previewInviteLink(parsed.data.token, memberId(req));
      return success(reply, {
        club: serializeSummary(preview.club),
        alreadyMember: preview.alreadyMember,
      });
    } catch (err) {
      return handleClubError(reply, err);
    }
  });

  app.post('/clubs/join', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = clubTokenSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const result = await clubService.joinViaLink(parsed.data.token, actor(req));
      return success(reply, {
        club: serializeSummary(result.club),
        joined: result.joined,
        alreadyMember: result.alreadyMember,
      });
    } catch (err) {
      return handleClubError(reply, err);
    }
  });

  // ── Group activity (club-linked reservations) ──

  app.get<{ Params: { id: string } }>(
    '/clubs/:id/activity',
    { config: { policy: 'member' } },
    async (req, reply) => {
      const parsed = clubActivityQuerySchema.safeParse(req.query);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        // The clubs service gates membership (404 for outsiders); the
        // bookings context serves the read. Club membership is NOT booking
        // participation, so the feed rides the reduced non-participant
        // projection, never the detail serialization.
        await clubService.assertMember(req.params.id, memberId(req));
        const reservations = await reservationService.listForClub(req.params.id, parsed.data.filter);
        return success(
          reply,
          reservations.map((reservation) =>
            serializeClubActivityReservation(reservation, {
              timezone: VENUE_TIMEZONE,
              viewerMemberId: memberId(req),
            }),
          ),
        );
      } catch (err) {
        return handleClubError(reply, err);
      }
    },
  );
}
