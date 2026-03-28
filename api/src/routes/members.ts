import type { FastifyInstance } from 'fastify';
import { memberService } from '@/lib/container';
import { createMemberSchema, updateMemberSchema, membersQuerySchema, createNoteSchema } from '@/src/lib/validation';
import { success, error } from '@/src/lib/responses';
import { MemberNotFoundError, DuplicateEmailError } from '@/lib/contexts/members';

export async function memberRoutes(app: FastifyInstance) {
  // List members
  app.get('/', async (req, reply) => {
    const query = req.query as Record<string, string>;
    const parsed = membersQuerySchema.safeParse(query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const result = await memberService.list(parsed.data);
    return success(reply, result);
  });

  // Get member by ID
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    try {
      const member = await memberService.getById(req.params.id);
      return success(reply, member);
    } catch (e) {
      if (e instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      throw e;
    }
  });

  // Create member
  app.post('/', async (req, reply) => {
    const parsed = createMemberSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const member = await memberService.create(parsed.data);
      return success(reply, member, 201);
    } catch (e) {
      if (e instanceof DuplicateEmailError) return error(reply, 'DUPLICATE_EMAIL', e.message, 409);
      throw e;
    }
  });

  // Update member
  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const parsed = updateMemberSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const member = await memberService.update(req.params.id, parsed.data);
      return success(reply, member);
    } catch (e) {
      if (e instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      if (e instanceof DuplicateEmailError) return error(reply, 'DUPLICATE_EMAIL', e.message, 409);
      throw e;
    }
  });

  // Add note
  app.post<{ Params: { id: string } }>('/:id/notes', async (req, reply) => {
    const parsed = createNoteSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const note = await memberService.addNote(req.params.id, req.user!.userId, parsed.data.content);
      return success(reply, note, 201);
    } catch (e) {
      if (e instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      throw e;
    }
  });
}
