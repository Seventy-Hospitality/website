import type { FastifyInstance } from 'fastify';
import { memberQrService } from '@/lib/container';
import { QrTokenError } from '@/lib/contexts/members';
import { error, success } from '@/src/lib/responses';
import { qrVerifySchema } from '@/src/lib/validation';

/**
 * Staff gate scanner: validates a member QR token (signature + expiry) and
 * answers with the member identity. A deleted member's still-fresh token
 * verifies cryptographically but is refused by the service's member
 * re-read.
 */
export async function qrRoutes(app: FastifyInstance) {
  app.post('/verify', { config: { policy: 'staff' } }, async (req, reply) => {
    const parsed = qrVerifySchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const result = await memberQrService.verify(parsed.data.token);
      return success(reply, {
        memberId: result.memberId,
        memberNumber: result.memberNumber,
        firstName: result.firstName,
        lastName: result.lastName,
        displayName: result.displayName,
        avatarUrl: result.avatarUrl,
        membershipStatus: result.membershipStatus,
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof QrTokenError) {
        // Expired asks the member to refresh their code; anything else is
        // one opaque "invalid" (tamper details never leave the API).
        return err.reason === 'expired'
          ? error(reply, 'QR_EXPIRED', 'This QR code has expired', 410)
          : error(reply, 'QR_INVALID', 'This QR code is not valid', 404);
      }
      throw err;
    }
  });
}
