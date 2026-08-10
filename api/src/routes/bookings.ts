import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  reservationService,
  resourceRepo,
  resourceTypeRepo,
  VENUE_TIMEZONE,
} from '@/lib/container';
import type { Resource, ResourceType } from '@/lib/contexts/bookings';
import { ResourceTypeNotFoundError } from '@/lib/contexts/bookings';
import { minutesToTimeLabel, timeLabelToMinutes } from '@/lib/kernel';
import { handleReservationError, serializeLegacyBooking } from '@/src/lib/reservations';
import { error, success } from '@/src/lib/responses';
import {
  adminReservationsQuerySchema,
  availabilityQuerySchema,
  createBookingSchema,
  createFacilitySchema,
  createResourceSchema,
  createResourceTypeSchema,
  updateFacilitySchema,
  updateResourceSchema,
  updateResourceTypeSchema,
} from '@/src/lib/validation';

// The legacy admin surface maps courts and showers onto the resource model:
// "courts" are the court-class resource types, "showers" the shower type.
// Facility config lives on the TYPE now; legacy per-facility config edits are
// applied to the resource's type.
const COURT_TYPE_CODES = ['badminton_court', 'tennis_court'];
const SHOWER_TYPE_CODES = ['shower'];
const LEGACY_CREATE_TYPE: Record<string, string> = { court: 'badminton_court', shower: 'shower' };

function serializeLegacyFacility(resource: Resource, type: ResourceType) {
  return {
    id: resource.id,
    name: resource.name,
    active: resource.active,
    typeCode: type.code,
    slotDurationMinutes: type.slotDurationMinutes,
    operatingHoursStart: minutesToTimeLabel(type.opStartMinutes),
    operatingHoursEnd: minutesToTimeLabel(type.opEndMinutes),
    maxAdvanceDays: type.maxAdvanceDays,
    maxBookingsPerMemberPerDay: type.maxReservationsPerMemberPerDay,
    cancellationDeadlineMinutes: type.cancellationDeadlineMinutes,
    hourlyRateCents: type.hourlyRateCents,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

async function listLegacyFacilities(codes: string[], includeInactive: boolean) {
  const types = (await resourceTypeRepo.listAll()).filter((type) => codes.includes(type.code));
  const typeById = new Map(types.map((type) => [type.id, type]));
  const resources = await resourceRepo.listByTypeIds(types.map((type) => type.id));
  return resources
    .filter((resource) => includeInactive || resource.active)
    .map((resource) => serializeLegacyFacility(resource, typeById.get(resource.typeId)!));
}

function legacyConfigToTypeUpdate(data: {
  slotDurationMinutes?: number;
  operatingHoursStart?: string;
  operatingHoursEnd?: string;
  maxAdvanceDays?: number;
  maxBookingsPerMemberPerDay?: number;
  cancellationDeadlineMinutes?: number;
}) {
  return {
    ...(data.slotDurationMinutes !== undefined ? { slotDurationMinutes: data.slotDurationMinutes } : {}),
    ...(data.operatingHoursStart !== undefined
      ? { opStartMinutes: timeLabelToMinutes(data.operatingHoursStart) }
      : {}),
    ...(data.operatingHoursEnd !== undefined
      ? { opEndMinutes: timeLabelToMinutes(data.operatingHoursEnd) }
      : {}),
    ...(data.maxAdvanceDays !== undefined ? { maxAdvanceDays: data.maxAdvanceDays } : {}),
    ...(data.maxBookingsPerMemberPerDay !== undefined
      ? { maxReservationsPerMemberPerDay: data.maxBookingsPerMemberPerDay }
      : {}),
    ...(data.cancellationDeadlineMinutes !== undefined
      ? { cancellationDeadlineMinutes: data.cancellationDeadlineMinutes }
      : {}),
  };
}

function adminActor(req: FastifyRequest): string {
  return req.principal!.userId;
}

export async function bookingRoutes(app: FastifyInstance) {
  // ── Resource types (admin management; the member catalog is GET /api/resource-types) ──

  app.get('/resource-types/all', { config: { policy: 'admin' } }, async (_req, reply) => {
    const types = await resourceTypeRepo.listAll();
    return success(reply, types);
  });

  app.post('/resource-types', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = createResourceTypeSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const existing = await resourceTypeRepo.getByCode(parsed.data.code);
    if (existing) return error(reply, 'DUPLICATE_CODE', `Resource type ${parsed.data.code} already exists`, 409);

    const type = await resourceTypeRepo.create(parsed.data);
    return success(reply, type, 201);
  });

  app.patch<{ Params: { id: string } }>('/resource-types/:id', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = updateResourceTypeSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const existing = await resourceTypeRepo.getById(req.params.id);
    if (!existing) return error(reply, 'NOT_FOUND', `Resource type not found: ${req.params.id}`, 404);

    const type = await resourceTypeRepo.update(req.params.id, parsed.data);
    return success(reply, type);
  });

  // ── Resources (admin management) ──

  app.get('/resources', { config: { policy: 'admin' } }, async (_req, reply) => {
    const resources = await resourceRepo.listAll();
    return success(reply, resources);
  });

  app.post('/resources', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = createResourceSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const type = await resourceTypeRepo.getById(parsed.data.typeId);
    if (!type) return error(reply, 'NOT_FOUND', `Resource type not found: ${parsed.data.typeId}`, 404);

    const resource = await resourceRepo.create(parsed.data);
    return success(reply, resource, 201);
  });

  app.patch<{ Params: { id: string } }>('/resources/:id', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = updateResourceSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const existing = await resourceRepo.getById(req.params.id);
    if (!existing) return error(reply, 'NOT_FOUND', `Resource not found: ${req.params.id}`, 404);

    const resource = await resourceRepo.update(req.params.id, parsed.data);
    return success(reply, resource);
  });

  // ── Legacy facility surface (admin web compat) ──

  app.get('/courts', { config: { policy: 'admin' } }, async (_req, reply) => {
    return success(reply, await listLegacyFacilities(COURT_TYPE_CODES, false));
  });

  app.get('/courts/all', { config: { policy: 'admin' } }, async (_req, reply) => {
    return success(reply, await listLegacyFacilities(COURT_TYPE_CODES, true));
  });

  app.get('/showers', { config: { policy: 'admin' } }, async (_req, reply) => {
    return success(reply, await listLegacyFacilities(SHOWER_TYPE_CODES, false));
  });

  app.get('/showers/all', { config: { policy: 'admin' } }, async (_req, reply) => {
    return success(reply, await listLegacyFacilities(SHOWER_TYPE_CODES, true));
  });

  for (const [facility, codes] of [
    ['courts', COURT_TYPE_CODES],
    ['showers', SHOWER_TYPE_CODES],
  ] as const) {
    // Create a facility = create a resource under the class's default type;
    // any legacy config fields update the type (config is type-level now).
    app.post(`/${facility}`, { config: { policy: 'admin' } }, async (req, reply) => {
      const parsed = createFacilitySchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      const typeCode = LEGACY_CREATE_TYPE[facility === 'courts' ? 'court' : 'shower'];
      const type = await resourceTypeRepo.getByCode(typeCode);
      if (!type) return handleReservationError(reply, new ResourceTypeNotFoundError(typeCode));

      const configUpdate = legacyConfigToTypeUpdate(parsed.data);
      const updatedType = Object.keys(configUpdate).length > 0
        ? await resourceTypeRepo.update(type.id, configUpdate)
        : type;

      const resource = await resourceRepo.create({ typeId: type.id, name: parsed.data.name });
      return success(reply, serializeLegacyFacility(resource, updatedType), 201);
    });

    app.patch<{ Params: { id: string } }>(`/${facility}/:id`, { config: { policy: 'admin' } }, async (req, reply) => {
      const parsed = updateFacilitySchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      const existing = await resourceRepo.getById(req.params.id);
      if (!existing) return error(reply, 'NOT_FOUND', `Resource not found: ${req.params.id}`, 404);

      let type = (await resourceTypeRepo.getById(existing.typeId))!;
      if (!codes.includes(type.code)) {
        return error(reply, 'NOT_FOUND', `Resource not found: ${req.params.id}`, 404);
      }

      const configUpdate = legacyConfigToTypeUpdate(parsed.data);
      if (Object.keys(configUpdate).length > 0) {
        type = await resourceTypeRepo.update(type.id, configUpdate);
      }

      const resource = await resourceRepo.update(req.params.id, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      });
      return success(reply, serializeLegacyFacility(resource, type));
    });

    app.get<{ Params: { id: string } }>(
      `/${facility}/:id/availability`,
      { config: { policy: 'admin' } },
      async (req, reply) => {
        const parsed = availabilityQuerySchema.safeParse(req.query);
        if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

        try {
          const slots = await reservationService.getResourceAvailability(req.params.id, parsed.data.date);
          return success(reply, slots);
        } catch (err) {
          return handleReservationError(reply, err);
        }
      },
    );

    // Admin-created reservation: organizer is the target member,
    // createdByAdminId set, payment comped.
    app.post<{ Params: { id: string } }>(
      `/${facility}/:id/bookings`,
      { config: { policy: 'admin' } },
      async (req, reply) => {
        const parsed = createBookingSchema.safeParse(req.body);
        if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

        const resource = await resourceRepo.getById(req.params.id);
        if (!resource) return error(reply, 'NOT_FOUND', `Resource not found: ${req.params.id}`, 404);
        const type = (await resourceTypeRepo.getById(resource.typeId))!;

        try {
          const result = await reservationService.create({
            typeCode: type.code,
            date: parsed.data.date,
            slots: [parsed.data.startTime],
            organizerId: parsed.data.memberId,
            resourceId: resource.id,
            admin: { adminUserId: adminActor(req) },
            actorId: adminActor(req),
          });
          return success(reply, serializeLegacyBooking(result.reservation, VENUE_TIMEZONE), 201);
        } catch (err) {
          return handleReservationError(reply, err);
        }
      },
    );

    app.delete<{ Params: { id: string; bookingId: string } }>(
      `/${facility}/:id/bookings/:bookingId`,
      { config: { policy: 'admin' } },
      async (req, reply) => {
        try {
          // Admin cancellation refunds in full: the club cancelled.
          await reservationService.cancel(req.params.bookingId, {
            fullRefund: true,
            actorId: adminActor(req),
          });
          return success(reply, { cancelled: true });
        } catch (err) {
          return handleReservationError(reply, err);
        }
      },
    );
  }

  // ── Reservations (admin view) ──

  app.get('/bookings', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = adminReservationsQuerySchema.safeParse(req.query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const reservations = await reservationService.listAll({
      localDate: parsed.data.date,
      includeInactive: parsed.data.includeInactive,
    });
    return success(
      reply,
      reservations.map((reservation) => serializeLegacyBooking(reservation, VENUE_TIMEZONE)),
    );
  });

  app.get<{ Params: { type: string; id: string } }>(
    '/facilities/:type/:id/booking-count',
    { config: { policy: 'admin' } },
    async (req, reply) => {
      const { type, id } = req.params;
      if (type !== 'court' && type !== 'shower') return error(reply, 'VALIDATION_ERROR', 'Invalid facility type');
      const count = await reservationService.countUpcomingForResources([id]);
      return success(reply, { count });
    },
  );
}
