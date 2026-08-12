import type { FastifyInstance } from 'fastify';
import { clubEventService } from '@/lib/container';
import {
  ClubEventCourtConflictError,
  ClubEventCourtNotFoundError,
  ClubEventNotFoundError,
  ClubEventValidationError,
} from '@/lib/contexts/events';
import { success, error } from '@/src/lib/responses';
import { createEventSchema, eventsQuerySchema, updateEventSchema } from '@/src/lib/validation';

export async function eventRoutes(app: FastifyInstance) {
  app.get('/', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = eventsQuerySchema.safeParse(req.query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const events = await clubEventService.list(parsed.data);
    return success(reply, events);
  });

  app.get<{ Params: { id: string } }>('/:id', { config: { policy: 'admin' } }, async (req, reply) => {
    try {
      const event = await clubEventService.getById(req.params.id);
      return success(reply, event);
    } catch (e) {
      return handleEventError(reply, e);
    }
  });

  app.post('/', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const event = await clubEventService.create(parsed.data);
      return success(reply, event, 201);
    } catch (e) {
      return handleEventError(reply, e);
    }
  });

  app.patch<{ Params: { id: string } }>('/:id', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = updateEventSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const event = await clubEventService.update(req.params.id, parsed.data);
      return success(reply, event);
    } catch (e) {
      return handleEventError(reply, e);
    }
  });
}

function handleEventError(reply: any, e: unknown) {
  if (e instanceof ClubEventNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
  if (e instanceof ClubEventCourtNotFoundError) return error(reply, 'COURT_NOT_FOUND', e.message, 404);
  if (e instanceof ClubEventCourtConflictError) {
    return error(reply, 'COURT_CONFLICT', e.message, 409, { conflicts: e.conflicts });
  }
  if (e instanceof ClubEventValidationError) return error(reply, 'INVALID_EVENT', e.message, 422);
  throw e;
}
