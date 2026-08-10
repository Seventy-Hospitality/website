import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  accountLinkingService,
  bookingService,
  clubEventService,
  memberRepo,
  memberService,
  membershipService,
  planRepo,
} from '@/lib/container';
import {
  BookingNotFoundError,
  BookingInPastError,
  BookingTooFarInAdvanceError,
  CancellationDeadlinePassedError,
  FacilityNotFoundError,
  InactiveMembershipError,
  MaxBookingsExceededError,
  OutsideOperatingHoursError,
  SlotUnavailableError,
} from '@/lib/contexts/bookings';
import { MemberNotFoundError } from '@/lib/contexts/members';
import { MembershipError, PlanNotFoundError } from '@/lib/contexts/memberships';
import type { LinkedCredentials, Provider } from '@/lib/contexts/identity';
import { handleIdentityError } from '@/src/lib/identity-errors';
import { error, success } from '@/src/lib/responses';
import { createSelfBookingSchema, linkProviderSchema, meCheckoutSchema } from '@/src/lib/validation';

type MemberProfile = Awaited<ReturnType<typeof memberService.getById>>;
type UpcomingBooking = Awaited<ReturnType<typeof bookingService.getMyBookings>>[number];
type ClubEvent = Awaited<ReturnType<typeof clubEventService.list>>[number];

function serializeMember(member: MemberProfile) {
  return {
    id: member.id,
    email: member.email,
    firstName: member.firstName,
    lastName: member.lastName,
    phone: member.phone,
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

function serializeBooking(
  booking: UpcomingBooking,
  facilityNames: Map<string, string>,
) {
  return {
    id: booking.id,
    facilityType: booking.facilityType,
    facilityId: booking.facilityId,
    facilityName: facilityNames.get(`${booking.facilityType}:${booking.facilityId}`) ?? booking.facilityId,
    date: booking.date.toISOString().slice(0, 10),
    startTime: booking.startTime,
    endTime: booking.endTime,
    status: booking.status,
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

async function getFacilityNames() {
  const [courts, showers] = await Promise.all([
    bookingService.listAllCourts(),
    bookingService.listAllShowers(),
  ]);

  return new Map<string, string>([
    ...courts.map((court) => [`court:${court.id}`, court.name] as const),
    ...showers.map((shower) => [`shower:${shower.id}`, shower.name] as const),
  ]);
}

function handleMemberError(reply: FastifyReply, err: unknown) {
  // Only reachable if the profile was deleted between the principal read and
  // the request being served.
  if (err instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof FacilityNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof BookingNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof SlotUnavailableError) return error(reply, 'SLOT_UNAVAILABLE', err.message, 409);
  if (err instanceof OutsideOperatingHoursError) return error(reply, 'OUTSIDE_HOURS', err.message, 422);
  if (err instanceof MaxBookingsExceededError) return error(reply, 'MAX_BOOKINGS', err.message, 422);
  if (err instanceof BookingTooFarInAdvanceError) return error(reply, 'TOO_FAR_ADVANCE', err.message, 422);
  if (err instanceof BookingInPastError) return error(reply, 'BOOKING_IN_PAST', err.message, 422);
  if (err instanceof CancellationDeadlinePassedError) return error(reply, 'DEADLINE_PASSED', err.message, 422);
  if (err instanceof InactiveMembershipError) return error(reply, 'INACTIVE_MEMBERSHIP', err.message, 403);
  if (err instanceof PlanNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof MembershipError) return error(reply, 'MEMBERSHIP_ERROR', err.message, 400);
  throw err;
}

export async function meRoutes(app: FastifyInstance) {
  // ── Profile ──

  app.get('/profile', { config: { policy: 'member' } }, async (req, reply) => {
    try {
      const [member, plans] = await Promise.all([currentMember(req), planRepo.list()]);
      return success(reply, { member: serializeMember(member), plans });
    } catch (err) {
      return handleMemberError(reply, err);
    }
  });

  app.get('/home', { config: { policy: 'member' } }, async (req, reply) => {
    try {
      const [member, events, facilityNames, bookings] = await Promise.all([
        currentMember(req),
        clubEventService.list({ includeInactive: false, includePast: false }),
        getFacilityNames(),
        bookingService.getMyBookings(memberId(req)),
      ]);

      return success(reply, {
        member: serializeMember(member),
        spotlightEvents: events.slice(0, 6).map(serializeEvent),
        upcomingBookings: bookings.slice(0, 8).map((booking) => serializeBooking(booking, facilityNames)),
      });
    } catch (err) {
      return handleMemberError(reply, err);
    }
  });

  // ── Bookings ──

  app.get('/bookings', { config: { policy: 'member' } }, async (req, reply) => {
    const [facilityNames, bookings] = await Promise.all([
      getFacilityNames(),
      bookingService.getMyBookings(memberId(req)),
    ]);

    return success(
      reply,
      bookings.map((booking) => serializeBooking(booking, facilityNames)),
    );
  });

  app.post('/bookings', { config: { policy: 'active-member' } }, async (req, reply) => {
    const parsed = createSelfBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(reply, 'VALIDATION_ERROR', parsed.error.message);
    }

    try {
      const booking = parsed.data.facilityType === 'court'
        ? await bookingService.bookCourt(
            parsed.data.facilityId,
            parsed.data.date,
            parsed.data.startTime,
            memberId(req),
          )
        : await bookingService.bookShower(
            parsed.data.facilityId,
            parsed.data.date,
            parsed.data.startTime,
            memberId(req),
          );

      const facilityNames = await getFacilityNames();
      return success(reply, serializeBooking(booking, facilityNames), 201);
    } catch (err) {
      return handleMemberError(reply, err);
    }
  });

  // Cancelling is deliberately `member`, not `active-member`: a lapsed member
  // must still be able to release a slot they are holding, and ownership is
  // checked by the booking service.
  app.delete<{ Params: { bookingId: string } }>(
    '/bookings/:bookingId',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        await bookingService.cancel(req.params.bookingId, memberId(req));
        return success(reply, { cancelled: true });
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
