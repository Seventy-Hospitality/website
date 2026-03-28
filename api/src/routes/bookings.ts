import type { FastifyInstance } from 'fastify';
import { bookingService } from '@/lib/container';
import { createBookingSchema, availabilityQuerySchema } from '@/src/lib/validation';
import { success, error } from '@/src/lib/responses';
import {
  SlotUnavailableError,
  OutsideOperatingHoursError,
  MaxBookingsExceededError,
  BookingTooFarInAdvanceError,
  BookingInPastError,
  CancellationDeadlinePassedError,
  BookingNotFoundError,
  FacilityNotFoundError,
  InactiveMembershipError,
} from '@/lib/contexts/bookings';

export async function bookingRoutes(app: FastifyInstance) {
  // ── Courts ──

  app.get('/courts', async (_req, reply) => {
    const courts = await bookingService.listCourts();
    return success(reply, courts);
  });

  app.get<{ Params: { id: string } }>('/courts/:id/availability', async (req, reply) => {
    const parsed = availabilityQuerySchema.safeParse(req.query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const slots = await bookingService.getCourtAvailability(req.params.id, parsed.data.date);
      return success(reply, slots);
    } catch (e) {
      if (e instanceof FacilityNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      throw e;
    }
  });

  app.post<{ Params: { id: string } }>('/courts/:id/bookings', async (req, reply) => {
    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const booking = await bookingService.bookCourt(
        req.params.id,
        parsed.data.date,
        parsed.data.startTime,
        parsed.data.memberId,
      );
      return success(reply, booking, 201);
    } catch (e) {
      return handleBookingError(reply, e);
    }
  });

  app.delete<{ Params: { id: string; bookingId: string } }>(
    '/courts/:id/bookings/:bookingId',
    async (req, reply) => {
      try {
        await bookingService.adminCancel(req.params.bookingId);
        return success(reply, { cancelled: true });
      } catch (e) {
        return handleBookingError(reply, e);
      }
    },
  );

  // ── Showers ──

  app.get('/showers', async (_req, reply) => {
    const showers = await bookingService.listShowers();
    return success(reply, showers);
  });

  app.get<{ Params: { id: string } }>('/showers/:id/availability', async (req, reply) => {
    const parsed = availabilityQuerySchema.safeParse(req.query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const slots = await bookingService.getShowerAvailability(req.params.id, parsed.data.date);
      return success(reply, slots);
    } catch (e) {
      if (e instanceof FacilityNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      throw e;
    }
  });

  app.post<{ Params: { id: string } }>('/showers/:id/bookings', async (req, reply) => {
    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const booking = await bookingService.bookShower(
        req.params.id,
        parsed.data.date,
        parsed.data.startTime,
        parsed.data.memberId,
      );
      return success(reply, booking, 201);
    } catch (e) {
      return handleBookingError(reply, e);
    }
  });

  app.delete<{ Params: { id: string; bookingId: string } }>(
    '/showers/:id/bookings/:bookingId',
    async (req, reply) => {
      try {
        await bookingService.adminCancel(req.params.bookingId);
        return success(reply, { cancelled: true });
      } catch (e) {
        return handleBookingError(reply, e);
      }
    },
  );

  // ── All Bookings (admin view) ──

  app.get('/bookings', async (req, reply) => {
    const query = req.query as Record<string, string>;
    const date = query.date;
    const bookings = await bookingService.listBookings(date);
    return success(reply, bookings);
  });
}

function handleBookingError(reply: any, e: unknown) {
  if (e instanceof FacilityNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
  if (e instanceof BookingNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
  if (e instanceof SlotUnavailableError) return error(reply, 'SLOT_UNAVAILABLE', e.message, 409);
  if (e instanceof OutsideOperatingHoursError) return error(reply, 'OUTSIDE_HOURS', e.message, 422);
  if (e instanceof MaxBookingsExceededError) return error(reply, 'MAX_BOOKINGS', e.message, 422);
  if (e instanceof BookingTooFarInAdvanceError) return error(reply, 'TOO_FAR_ADVANCE', e.message, 422);
  if (e instanceof BookingInPastError) return error(reply, 'BOOKING_IN_PAST', e.message, 422);
  if (e instanceof CancellationDeadlinePassedError) return error(reply, 'DEADLINE_PASSED', e.message, 422);
  if (e instanceof InactiveMembershipError) return error(reply, 'INACTIVE_MEMBERSHIP', e.message, 403);
  throw e;
}
