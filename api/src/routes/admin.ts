import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { userRepo } from '@/lib/container';
import { error, success } from '@/src/lib/responses';

export async function adminRoutes(app: FastifyInstance) {
  app.get('/users', { config: { policy: 'admin' } }, async (_req, reply) => {
    const users = await userRepo.listAdmins();
    return success(reply, users);
  });

  app.post('/users', { config: { policy: 'admin' } }, async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      name: z.string().min(1),
    }).safeParse(req.body);

    if (!body.success) {
      return error(reply, 'VALIDATION_ERROR', 'Invalid admin user data');
    }

    const existing = await userRepo.findByEmail(body.data.email);
    if (existing) {
      return error(reply, 'CONFLICT', 'User already exists');
    }

    const user = await userRepo.create(body.data.email, body.data.name, 'admin');
    return success(reply, user);
  });

  app.delete('/users/:id', { config: { policy: 'admin' } }, async (req, reply) => {
    const { id } = req.params as { id: string };

    if (req.principal?.userId === id) {
      return error(reply, 'FORBIDDEN', 'Cannot remove yourself');
    }

    await userRepo.delete(id);
    return success(reply, { deleted: true });
  });
}
