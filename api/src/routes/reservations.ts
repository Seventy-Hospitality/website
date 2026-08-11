import type { FastifyInstance, FastifyRequest } from 'fastify';
import { reservationService, seriesService, VENUE_TIMEZONE } from '@/lib/container';
import { error, success } from '@/src/lib/responses';
import { handleReservationError, serializeReservation } from '@/src/lib/reservations';
import {
  addParticipantsSchema,
  availabilityQuerySchema,
  createReservationSchema,
  createReservationSeriesSchema,
  rescheduleReservationSchema,
  reservationQuoteSchema,
  respondReservationSchema,
} from '@/src/lib/validation';

function memberId(req: FastifyRequest): string {
  return req.principal!.memberId!;
}

function actorId(req: FastifyRequest): string {
  return req.principal!.userId;
}

/**
 * Member-facing scheduling surface. Policies follow the ladder; resource
 * ownership (organizer, participant, invite permission) is enforced in the
 * reservation service, which answers with 404-shaped errors for outsiders.
 */
export async function reservationRoutes(app: FastifyInstance) {
  // ── Catalog ──

  app.get('/resource-types', { config: { policy: 'member' } }, async (req, reply) => {
    const types = await reservationService.listResourceTypesForMember(memberId(req));
    return success(
      reply,
      types.map((type) => ({
        code: type.code,
        name: type.name,
        slotDurationMinutes: type.slotDurationMinutes,
        opStartMinutes: type.opStartMinutes,
        opEndMinutes: type.opEndMinutes,
        hourlyRateCents: type.hourlyRateCents,
        maxAdvanceDays: type.maxAdvanceDays,
        minTier: type.minTier,
        locked: type.locked,
        resourceCount: type.resourceCount,
        icon: type.code,
      })),
    );
  });

  // ── Availability ──

  app.get<{ Params: { code: string } }>(
    '/resource-types/:code/availability',
    { config: { policy: 'active-member' } },
    async (req, reply) => {
      const parsed = availabilityQuerySchema.safeParse(req.query);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const days = await reservationService.getAvailability({
          typeCode: req.params.code,
          startDate: parsed.data.date,
          days: parsed.data.days,
          memberId: memberId(req),
        });
        return success(reply, days);
      } catch (err) {
        return handleReservationError(reply, err);
      }
    },
  );

  // ── Quote ──

  app.post('/reservations/quote', { config: { policy: 'active-member' } }, async (req, reply) => {
    const parsed = reservationQuoteSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const quote = await reservationService.quote({ ...parsed.data, memberId: memberId(req) });
      return success(reply, quote);
    } catch (err) {
      return handleReservationError(reply, err);
    }
  });

  // ── Create (checkout) ──

  app.post('/reservations', { config: { policy: 'active-member' } }, async (req, reply) => {
    const parsed = createReservationSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const result = await reservationService.create({
        typeCode: parsed.data.typeCode,
        date: parsed.data.date,
        slots: parsed.data.slots,
        organizerId: memberId(req),
        inviteeMemberIds: parsed.data.invitees?.memberIds,
        inviteeClubIds: parsed.data.invitees?.clubIds,
        actorId: actorId(req),
      });
      return success(
        reply,
        {
          reservation: serializeReservation(result.reservation, {
            timezone: VENUE_TIMEZONE,
            viewerMemberId: memberId(req),
          }),
          totalCents: result.totalCents,
          clientSecret: result.clientSecret,
          holdExpiresAt: result.holdExpiresAt?.toISOString() ?? null,
        },
        201,
      );
    } catch (err) {
      return handleReservationError(reply, err);
    }
  });

  // ── Confirm (organizer; service enforces ownership) ──

  app.post<{ Params: { id: string } }>(
    '/reservations/:id/confirm',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        const reservation = await reservationService.confirm(req.params.id, {
          memberId: memberId(req),
          actorId: actorId(req),
        });
        return success(
          reply,
          serializeReservation(reservation, { timezone: VENUE_TIMEZONE, viewerMemberId: memberId(req) }),
        );
      } catch (err) {
        return handleReservationError(reply, err);
      }
    },
  );

  // ── Detail (any participant) ──

  app.get<{ Params: { id: string } }>(
    '/reservations/:id',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        const { reservation, viewer } = await reservationService.getForViewer(req.params.id, memberId(req));
        return success(reply, {
          ...serializeReservation(reservation, { timezone: VENUE_TIMEZONE, viewerMemberId: memberId(req) }),
          viewer,
        });
      } catch (err) {
        return handleReservationError(reply, err);
      }
    },
  );

  // ── Reschedule (organizer) ──

  app.post<{ Params: { id: string } }>(
    '/reservations/:id/reschedule-quote',
    { config: { policy: 'active-member' } },
    async (req, reply) => {
      const parsed = rescheduleReservationSchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const quote = await reservationService.rescheduleQuote(req.params.id, memberId(req), parsed.data);
        return success(reply, quote);
      } catch (err) {
        return handleReservationError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/reservations/:id',
    { config: { policy: 'active-member' } },
    async (req, reply) => {
      const parsed = rescheduleReservationSchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const result = await reservationService.reschedule(
          req.params.id,
          memberId(req),
          parsed.data,
          actorId(req),
        );
        return success(reply, {
          reservation: serializeReservation(result.reservation, {
            timezone: VENUE_TIMEZONE,
            viewerMemberId: memberId(req),
          }),
          deltaCents: result.deltaCents,
          clientSecret: result.clientSecret,
        });
      } catch (err) {
        return handleReservationError(reply, err);
      }
    },
  );

  // ── Cancel (organizer) ──
  // Policy `member`, not `active-member`: a lapsed member must still be able
  // to release a slot they hold; ownership is checked in the service.

  app.delete<{ Params: { id: string } }>(
    '/reservations/:id',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        const { refundCents } = await reservationService.cancel(req.params.id, {
          memberId: memberId(req),
          actorId: actorId(req),
        });
        return success(reply, { cancelled: true, refundCents });
      } catch (err) {
        return handleReservationError(reply, err);
      }
    },
  );

  // ── Participants ──

  app.post<{ Params: { id: string } }>(
    '/reservations/:id/participants',
    { config: { policy: 'member' } },
    async (req, reply) => {
      const parsed = addParticipantsSchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const result = await reservationService.addParticipants(
          req.params.id,
          memberId(req),
          { memberIds: parsed.data.memberIds, clubIds: parsed.data.clubIds },
          actorId(req),
        );
        return success(reply, result);
      } catch (err) {
        return handleReservationError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; memberId: string } }>(
    '/reservations/:id/participants/:memberId',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        await reservationService.removeParticipant(
          req.params.id,
          memberId(req),
          req.params.memberId,
          actorId(req),
        );
        return success(reply, { removed: true });
      } catch (err) {
        return handleReservationError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/reservations/:id/respond',
    { config: { policy: 'member' } },
    async (req, reply) => {
      const parsed = respondReservationSchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const result = await reservationService.respond(
          req.params.id,
          memberId(req),
          parsed.data.response,
          actorId(req),
        );
        return success(reply, result);
      } catch (err) {
        return handleReservationError(reply, err);
      }
    },
  );

  // ── Weekly series (admin-only creation; plan OPEN decision 8) ──
  // Members see the Weekly badge on materialized reservations; creating or
  // cancelling the series itself is a staff action until a member UI is
  // designed.

  app.get('/admin/reservation-series', { config: { policy: 'admin' } }, async (_req, reply) => {
    const series = await seriesService.list();
    return success(reply, series.map(serializeSeries));
  });

  app.post('/admin/reservation-series', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = createReservationSeriesSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const series = await seriesService.create({
        organizerId: parsed.data.memberId,
        typeCode: parsed.data.typeCode,
        weekday: parsed.data.weekday,
        startTime: parsed.data.startTime,
        durationMinutes: parsed.data.durationMinutes,
        adminUserId: req.principal!.userId,
      });
      return success(reply, serializeSeries(series), 201);
    } catch (err) {
      return handleReservationError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/admin/reservation-series/:id',
    { config: { policy: 'admin' } },
    async (req, reply) => {
      try {
        const result = await seriesService.cancel(req.params.id, req.principal!.userId);
        return success(reply, result);
      } catch (err) {
        return handleReservationError(reply, err);
      }
    },
  );
}

type SeriesAdminItem = Awaited<ReturnType<typeof seriesService.list>>[number];

function serializeSeries(series: SeriesAdminItem) {
  return {
    id: series.id,
    member: {
      id: series.organizer.id,
      firstName: series.organizer.firstName,
      lastName: series.organizer.lastName,
      memberNumber: series.organizer.memberNumber,
    },
    typeCode: series.resourceType.code,
    typeName: series.resourceType.name,
    weekday: series.weekday,
    startTime: series.startTimeLocal,
    durationMinutes: series.durationMinutes,
    active: series.active,
    createdAt: series.createdAt.toISOString(),
  };
}
