import type { FastifyInstance } from 'fastify';
import { memberService } from '@/lib/container';
import { createMemberSchema, updateMemberSchema, membersQuerySchema, createNoteSchema, memberSearchQuerySchema } from '@/src/lib/validation';
import { success, error } from '@/src/lib/responses';
import { MemberNotFoundError, DuplicateEmailError } from '@/lib/contexts/members';

export async function memberRoutes(app: FastifyInstance) {
  // List members
  app.get('/', { config: { policy: 'admin' } }, async (req, reply) => {
    const query = req.query as Record<string, string>;
    const parsed = membersQuerySchema.safeParse(query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const result = await memberService.list(parsed.data);
    return success(reply, result);
  });

  // Member directory search for reservation invites. Members only, never
  // staff (staff have no row here); names only, no emails leak. Without a
  // query it serves the default alphabetical directory page (the invite
  // picker's pre-search list), which excludes the caller; a search keeps
  // its historical behavior (caller included) for the existing clients.
  app.get('/search', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = memberSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const { q, limit, page } = parsed.data;
    const offset = (page - 1) * limit;
    const results = q
      ? await memberService.search(q, limit, offset)
      : await memberService.browseDirectory(req.principal!.memberId!, limit, offset);
    return success(reply, results);
  });

  // Get member by ID
  app.get<{ Params: { id: string } }>('/:id', { config: { policy: 'admin' } }, async (req, reply) => {
    try {
      const member = await memberService.getById(req.params.id);
      return success(reply, member);
    } catch (e) {
      if (e instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      throw e;
    }
  });

  // Create member
  app.post('/', { config: { policy: 'admin' } }, async (req, reply) => {
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
  app.patch<{ Params: { id: string } }>('/:id', { config: { policy: 'admin' } }, async (req, reply) => {
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
  app.post<{ Params: { id: string } }>('/:id/notes', { config: { policy: 'admin' } }, async (req, reply) => {
    const parsed = createNoteSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const note = await memberService.addNote(req.params.id, req.principal!.userId, parsed.data.content);
      return success(reply, note, 201);
    } catch (e) {
      if (e instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      throw e;
    }
  });
}
