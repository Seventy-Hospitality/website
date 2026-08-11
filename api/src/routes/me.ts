import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  accountLinkingService,
  clubEventService,
  homeService,
  memberRepo,
  memberService,
  membershipService,
  planRepo,
  reservationService,
  resourceRepo,
  resourceTypeRepo,
  VENUE_TIMEZONE,
} from '@/lib/container';
import { MemberNotFoundError, MemberValidationError } from '@/lib/contexts/members';
import { MembershipError, PlanNotFoundError } from '@/lib/contexts/memberships';
import type { LinkedCredentials, Provider } from '@/lib/contexts/identity';
import { handleIdentityError } from '@/src/lib/identity-errors';
import { error, success } from '@/src/lib/responses';
import {
  handleReservationError,
  serializeLegacyBooking,
  serializeReservation,
} from '@/src/lib/reservations';
import { createSelfBookingSchema, linkProviderSchema, meCheckoutSchema, myReservationsQuerySchema, updateMyProfileSchema } from '@/src/lib/validation';

type MemberProfile = Awaited<ReturnType<typeof memberService.getById>>;
type ClubEvent = Awaited<ReturnType<typeof clubEventService.list>>[number];

function serializeMember(member: MemberProfile) {
  return {
    id: member.id,
    email: member.email,
    firstName: member.firstName,
    lastName: member.lastName,
    phone: member.phone,
    memberNumber: member.memberNumber,
    displayName: member.displayName,
    avatarUrl: member.avatarUrl,
    memberSince: member.createdAt.toISOString(),
    membership: member.membership
      ? {
          id: member.membership.id,
          status: member.membership.status,
          currentPeriodEnd: member.membership.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: member.membership.cancelAtPeriodEnd,
          plan: {
            id: member.membership.plan.id,
            name: member.membership.plan.name,
            amountCents: member.membership.plan.amountCents,
            interval: member.membership.plan.interval,
          },
        }
      : null,
  };
}

function serializeEvent(event: ClubEvent) {
  return {
    id: event.id,
    title: event.title,
    imageUrl: event.imageUrl,
    details: event.details,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    timezone: event.timezone,
    active: event.active,
    courts: event.courts,
  };
}

function serializeCredentials(credentials: LinkedCredentials) {
  return {
    hasPassword: credentials.hasPassword,
    identities: credentials.identities.map((identity) => ({
      provider: identity.provider,
      email: identity.email,
      isPrivateRelay: identity.isPrivateRelay,
      linkedAt: identity.linkedAt.toISOString(),
      lastUsedAt: identity.lastUsedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * The `member` policy already established that the caller has a club profile,
 * so the id comes from the principal and never from the email.
 */
function memberId(req: FastifyRequest): string {
  return req.principal!.memberId!;
}

function currentMember(req: FastifyRequest): Promise<MemberProfile> {
  return memberService.getById(memberId(req));
}

function handleMemberError(reply: FastifyReply, err: unknown) {
  // Only reachable if the profile was deleted between the principal read and
  // the request being served.
  if (err instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof PlanNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof MembershipError) return error(reply, 'MEMBERSHIP_ERROR', err.message, 400);
  return handleReservationError(reply, err);
}

export async function meRoutes(app: FastifyInstance) {
  // ── Profile ──

  app.get('/profile', { config: { policy: 'member' } }, async (req, reply) => {
    try {
      const [member, plans, stats] = await Promise.all([
        currentMember(req),
        planRepo.list(),
        reservationService.getLifetimeActivityStats(memberId(req)),
      ]);
      return success(reply, {
        member: serializeMember(member),
        plans,
        // Lifetime, confirmed-only, courts only; definition in
        // bookings/domain/activity-stats.ts and docs/decisions-account.md.
        stats: {
          courtsBooked: stats.courtsBooked,
          badmintonHours: stats.badmintonMinutes / 60,
          tennisHours: stats.tennisMinutes / 60,
        },
      });
    } catch (err) {
      return handleMemberError(reply, err);
    }
  });

  app.patch('/profile', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = updateMyProfileSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      await memberService.updateDisplayName(memberId(req), parsed.data.displayName);
      return success(reply, { member: serializeMember(await currentMember(req)) });
    } catch (err) {
      if (err instanceof MemberValidationError) return error(reply, 'VALIDATION_ERROR', err.message, 422);
      return handleMemberError(reply, err);
    }
  });

  // The home aggregation (package F): one payload with greeting, upcoming
  // reservations (viewer participation + Weekly badge), pending invitations
  // rendered distinctly, pending club invitations, spotlight events, the
  // quick-book suggestion, and the empty-state amenity summary. Everything
  // is keyed on the principal's member id; composition lives in the home
  // context's HomeService. The legacy member/upcomingBookings keys stay for
  // the existing clients.
  app.get('/home', { config: { policy: 'member' } }, async (req, reply) => {
    const rawTz = (req.query as Record<string, unknown> | undefined)?.tz;
    try {
      const [member, home] = await Promise.all([
        currentMember(req),
        homeService.getHome(memberId(req), {
          timezone: typeof rawTz === 'string' ? rawTz : null,
        }),
      ]);

      const serialize = (reservation: (typeof home.upcomingReservations)[number]) =>
        serializeReservation(reservation, { timezone: VENUE_TIMEZONE, viewerMemberId: memberId(req) });

      return success(reply, {
        member: serializeMember(member),
        greeting: home.greeting,
        spotlightEvents: home.spotlightEvents.slice(0, 6).map(serializeEvent),
        upcomingReservations: home.upcomingReservations.slice(0, 8).map(serialize),
        // Distinct list: the viewer's participation is pending and the card
        // renders inline Accept/Decline (myParticipation carries the
        // inviter's first name; POST /api/reservations/:id/respond answers).
        pendingInvitations: home.pendingInvitations.slice(0, 8).map(serialize),
        clubInvitations: home.clubInvitations.map((invitation) => ({
          id: invitation.id,
          club: invitation.club,
          invitedBy: invitation.invitedBy,
          createdAt: invitation.createdAt.toISOString(),
        })),
        quickBook: home.quickBook,
        // Present ONLY in the empty state (nothing upcoming, no invites).
        amenities: home.emptyStateAmenities,
        // Legacy member-portal shape (superset list, as before).
        upcomingBookings: [...home.upcomingReservations, ...home.pendingInvitations]
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
          .slice(0, 8)
          .map((reservation) =>
            serializeLegacyBooking(reservation, VENUE_TIMEZONE, { viewerMemberId: memberId(req) }),
          ),
      });
    } catch (err) {
      return handleMemberError(reply, err);
    }
  });

  // ── Reservations ──

  app.get('/reservations', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = myReservationsQuerySchema.safeParse(req.query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const reservations = await reservationService.listForMember(memberId(req), parsed.data.filter);
    return success(
      reply,
      reservations.map((reservation) =>
        serializeReservation(reservation, { timezone: VENUE_TIMEZONE, viewerMemberId: memberId(req) }),
      ),
    );
  });

  // ── Bookings (member-portal compat over the reservation service) ──

  app.get('/bookings', { config: { policy: 'member' } }, async (req, reply) => {
    const reservations = await reservationService.listForMember(memberId(req), 'upcoming');
    return success(
      reply,
      reservations.map((reservation) =>
        serializeLegacyBooking(reservation, VENUE_TIMEZONE, { viewerMemberId: memberId(req) }),
      ),
    );
  });

  // The portal books one slot on a named facility. The reservation is
  // created through the standard checkout (pending_payment + hold) and
  // confirmed through the payment port in the same request. With the real
  // Stripe adapter this confirm fails closed (the intent is unpaid) until
  // the web portal grows a PaymentSheet; keyless local dev books end to end
  // via the stub. The mobile flow uses /api/reservations + /confirm.
  app.post('/bookings', { config: { policy: 'active-member' } }, async (req, reply) => {
    const parsed = createSelfBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(reply, 'VALIDATION_ERROR', parsed.error.message);
    }

    try {
      const resource = await resourceRepo.getById(parsed.data.facilityId);
      if (!resource) return error(reply, 'NOT_FOUND', `Resource not found: ${parsed.data.facilityId}`, 404);
      const type = (await resourceTypeRepo.getById(resource.typeId))!;

      const created = await reservationService.create({
        typeCode: type.code,
        date: parsed.data.date,
        slots: [parsed.data.startTime],
        organizerId: memberId(req),
        resourceId: resource.id,
      });
      const confirmed = await reservationService.confirm(created.reservation.id, {
        memberId: memberId(req),
      });
      return success(
        reply,
        serializeLegacyBooking(confirmed, VENUE_TIMEZONE, { viewerMemberId: memberId(req) }),
        201,
      );
    } catch (err) {
      return handleMemberError(reply, err);
    }
  });

  // Cancelling is deliberately `member`, not `active-member`: a lapsed member
  // must still be able to release a slot they are holding, and ownership is
  // checked by the reservation service.
  app.delete<{ Params: { bookingId: string } }>(
    '/bookings/:bookingId',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        const { refundCents } = await reservationService.cancel(req.params.bookingId, {
          memberId: memberId(req),
        });
        return success(reply, { cancelled: true, refundCents });
      } catch (err) {
        return handleMemberError(reply, err);
      }
    },
  );

  // ── Billing ──
  // Member-facing variants of /api/stripe/*: the member comes from the
  // principal, never from the body (the body-driven routes stay admin-only).

  app.post('/checkout', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = meCheckoutSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const member = await currentMember(req);
      const { url, newStripeCustomerId } = await membershipService.createCheckoutSession(
        member.id,
        parsed.data.planId,
        member.email,
        `${member.firstName} ${member.lastName}`,
        member.stripeCustomerId,
      );
      if (newStripeCustomerId) {
        await memberRepo.setStripeCustomerId(member.id, newStripeCustomerId);
      }
      return success(reply, { url });
    } catch (err) {
      return handleMemberError(reply, err);
    }
  });

  app.post('/billing-portal', { config: { policy: 'member' } }, async (req, reply) => {
    try {
      const member = await currentMember(req);
      const url = await membershipService.createPortalSession(member.id, member.stripeCustomerId);
      return success(reply, { url });
    } catch (err) {
      return handleMemberError(reply, err);
    }
  });

  // ── Sign-in methods ──
  // Policy `authenticated`, not `member`: credentials belong to the user
  // account, which exists before (and independently of) a club profile.

  app.get('/auth-identities', { config: { policy: 'authenticated' } }, async (req, reply) => {
    const credentials = await accountLinkingService.listCredentials(req.principal!.userId);
    return success(reply, serializeCredentials(credentials));
  });

  app.post<{ Params: { provider: string } }>(
    '/auth-identities/:provider',
    { config: { policy: 'authenticated' } },
    async (req, reply) => {
      const provider = parseProvider(req.params.provider);
      if (!provider) return error(reply, 'VALIDATION_ERROR', 'Unsupported provider', 404);

      const parsed = linkProviderSchema.safeParse(req.body);
      if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

      try {
        const { linked } = await accountLinkingService.linkProvider(
          req.principal!.userId,
          provider,
          parsed.data,
          req.principal!.emailVerified,
        );
        return success(reply, { provider, linked });
      } catch (err) {
        return handleIdentityError(reply, err);
      }
    },
  );

  app.delete<{ Params: { provider: string } }>(
    '/auth-identities/:provider',
    { config: { policy: 'authenticated' } },
    async (req, reply) => {
      const provider = parseProvider(req.params.provider);
      if (!provider) return error(reply, 'VALIDATION_ERROR', 'Unsupported provider', 404);

      try {
        await accountLinkingService.unlinkProvider(req.principal!.userId, provider);
        return success(reply, { provider, unlinked: true });
      } catch (err) {
        return handleIdentityError(reply, err);
      }
    },
  );
}

function parseProvider(value: string): Provider | null {
  return value === 'google' || value === 'apple' ? value : null;
}
