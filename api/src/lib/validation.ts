import { z } from 'zod';

// Emails are stored and looked up lowercased; normalize at every entry point.
export const emailSchema = z.string().trim().toLowerCase().email();

const nullableTrimmedString = (maxLength: number) =>
  z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    },
    z.string().max(maxLength).nullable().optional(),
  );

const booleanQueryParam = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

export const createMemberSchema = z.object({
  email: emailSchema,
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  phone: z.string().max(30).optional(),
});

export const updateMemberSchema = z.object({
  email: emailSchema.optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  phone: z.string().max(30).nullable().optional(),
});

export const createNoteSchema = z.object({
  content: z.string().min(1).max(5000),
});

export const sendMagicLinkSchema = z.object({
  email: emailSchema,
  redirectTo: z.string().trim().min(1).max(2048).optional(),
});

// ── Identity ──

export const passwordSchema = z.string().min(8).max(256);

export const signUpSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: emailSchema,
  password: passwordSchema,
  phone: z.string().trim().max(30).optional(),
});

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});

export const oauthGoogleSchema = z.object({
  idToken: z.string().min(1),
  nonce: z.string().min(1).max(512),
});

export const oauthAppleSchema = z.object({
  identityToken: z.string().min(1),
  nonce: z.string().min(1).max(512),
  authorizationCode: z.string().min(1).optional(),
  fullName: z
    .object({
      givenName: z.string().trim().max(100).optional(),
      familyName: z.string().trim().max(100).optional(),
    })
    .optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

/** Linking a provider from account settings; the account is the principal's. */
export const linkProviderSchema = z.object({
  idToken: z.string().min(1),
  nonce: z.string().min(1).max(512),
  authorizationCode: z.string().min(1).optional(),
});

export const createCheckoutSchema = z.object({
  memberId: z.string().min(1),
  planId: z.string().min(1),
});

// ── Billing (member-facing; the member always comes from the principal) ──

export const subscribeMembershipSchema = z.object({
  planId: z.string().min(1),
  /** Recorded server-side on the user row + subscription metadata. */
  termsVersion: z.string().trim().min(1).max(100),
});

export const changeMembershipSchema = z.object({
  planId: z.string().min(1),
});

export const cancelMembershipQuerySchema = z.object({
  /** Default cancels at period end; now=true cancels immediately, no refund. */
  now: booleanQueryParam,
});

export const billingTransactionsQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

/** Member-facing checkout: the member comes from the principal. */
export const meCheckoutSchema = z.object({
  planId: z.string().min(1),
});

export const createPortalSchema = z.object({
  memberId: z.string().min(1),
});

export const membersQuerySchema = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(250).default(20),
});

// ── Scheduling ──

export const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** "HH:MM" venue wall clock; hours may reach 24+ for past-midnight slots. */
export const slotLabelSchema = z.string().regex(/^\d{2}:\d{2}$/);

/** Admin compat: create a single-slot booking on a specific resource. */
export const createBookingSchema = z.object({
  memberId: z.string().min(1),
  date: dateKeySchema,
  startTime: slotLabelSchema,
});

/** Member-portal compat: book one slot on a named facility. */
export const createSelfBookingSchema = z.object({
  facilityType: z.enum(['court', 'shower']),
  facilityId: z.string().min(1),
  date: dateKeySchema,
  startTime: slotLabelSchema,
});

export const availabilityQuerySchema = z.object({
  date: dateKeySchema,
  days: z.coerce.number().int().positive().max(31).optional(),
  /**
   * Edit-flow self-exclusion: the named reservation's own claims read as
   * free. The service verifies the caller participates in it (404-shaped
   * otherwise), so foreign reservations cannot be probed or excluded.
   */
  excludeReservationId: z.string().trim().min(1).max(64).optional(),
});

export const reservationQuoteSchema = z.object({
  typeCode: z.string().min(1).max(100),
  date: dateKeySchema,
  slots: z.array(slotLabelSchema).min(1).max(48),
});

export const createReservationSchema = reservationQuoteSchema.extend({
  invitees: z
    .object({
      memberIds: z.array(z.string().min(1)).max(50).optional(),
      // Club chips: each expands to the club's current member set.
      clubIds: z.array(z.string().min(1)).max(20).optional(),
    })
    .optional(),
});

export const rescheduleReservationSchema = z.object({
  date: dateKeySchema,
  slots: z.array(slotLabelSchema).min(1).max(48),
});

export const respondReservationSchema = z.object({
  response: z.enum(['accept', 'decline']),
});

export const addParticipantsSchema = z
  .object({
    memberIds: z.array(z.string().min(1)).max(50).optional(),
    clubIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .refine(
    (value) => (value.memberIds?.length ?? 0) + (value.clubIds?.length ?? 0) > 0,
    { message: 'At least one invitee (member or club) is required' },
  );

export const myReservationsQuerySchema = z.object({
  filter: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
});

/** Admin-only weekly series creation (plan OPEN decision 8). */
export const createReservationSeriesSchema = z.object({
  memberId: z.string().min(1),
  typeCode: z.string().min(1),
  weekday: z.number().int().min(0).max(6),
  startTime: slotLabelSchema,
  durationMinutes: z.number().int().positive(),
});

export const adminReservationsQuerySchema = z.object({
  date: dateKeySchema.optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const memberSearchQuerySchema = z.object({
  /** Absent or empty: the default alphabetical directory page instead. */
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().positive().max(25).default(10),
  /** 1-based page over either mode's ordering (offset = (page-1)*limit). */
  page: z.coerce.number().int().positive().max(10000).default(1),
});

export const createResourceTypeSchema = z.object({
  code: z.string().trim().min(1).max(100).regex(/^[a-z0-9_]+$/),
  name: z.string().trim().min(1).max(100),
  slotDurationMinutes: z.number().int().positive().optional(),
  opStartMinutes: z.number().int().min(0).max(1440),
  opEndMinutes: z.number().int().min(0).max(2880),
  hourlyRateCents: z.number().int().min(0),
  maxAdvanceDays: z.number().int().positive(),
  maxReservationsPerMemberPerDay: z.number().int().positive(),
  cancellationDeadlineMinutes: z.number().int().min(0),
  minTier: z.enum(['member', 'pro']).optional(),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
});

export const updateResourceTypeSchema = createResourceTypeSchema.omit({ code: true }).partial();

export const createResourceSchema = z.object({
  typeId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
});

export const updateResourceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
});

/** Admin compat: legacy court/shower config edits map onto the type. */
export const updateFacilitySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slotDurationMinutes: z.number().int().positive().optional(),
  operatingHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  operatingHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  maxAdvanceDays: z.number().int().positive().optional(),
  maxBookingsPerMemberPerDay: z.number().int().positive().optional(),
  cancellationDeadlineMinutes: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

export const createFacilitySchema = updateFacilitySchema.extend({
  name: z.string().min(1).max(100),
});

// ── Events ──

export const eventsQuerySchema = z.object({
  includeInactive: booleanQueryParam,
  includePast: booleanQueryParam,
});

export const createEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  imageUrl: nullableTrimmedString(2000),
  details: nullableTrimmedString(10000),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  timezone: z.string().trim().min(1).max(100).default('America/New_York'),
  active: z.boolean().optional(),
  courtIds: z.array(z.string().min(1)).optional(),
  cancelConflictingBookings: z.boolean().optional(),
});

export const updateEventSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  imageUrl: nullableTrimmedString(2000),
  details: nullableTrimmedString(10000),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  active: z.boolean().optional(),
  courtIds: z.array(z.string().min(1)).optional(),
  cancelConflictingBookings: z.boolean().optional(),
});

export const deleteManagedImageSchema = z.object({
  imageUrl: z.string().trim().min(1).max(2000),
});

export const cleanupManagedImagesQuerySchema = z.object({
  maxAgeHours: z.coerce.number().int().positive().max(24 * 365).default(24),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

// ── Clubs ──

export const createClubSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  inviteeMemberIds: z.array(z.string().min(1)).max(50).optional(),
});

export const updateClubSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    // Only explicit REMOVAL comes through PATCH; a new cover arrives via the
    // multipart upload endpoint, which owns the asset lifecycle.
    coverImageUrl: z.null().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const clubInvitationsSchema = z.object({
  memberIds: z.array(z.string().min(1)).min(1).max(50),
});

export const respondClubInvitationSchema = z.object({
  response: z.enum(['accept', 'decline']),
});

export const clubMemberRoleSchema = z.object({
  role: z.enum(['owner', 'member']),
});

export const clubInviteLinkSchema = z.object({
  expiresInDays: z.number().int().positive().max(365).optional(),
  maxUses: z.number().int().positive().max(500).optional(),
  // Additionally revoke every other active link (owner-only).
  rotate: z.boolean().optional(),
});

export const clubTokenSchema = z.object({
  token: z.string().trim().min(1).max(200),
});

export const clubActivityQuerySchema = z.object({
  filter: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
});

// ── Account surface (package E) ──

export const updateMyProfileSchema = z.object({
  // null (or empty string, normalized in the service) clears the display
  // name back to the first/last fallback.
  displayName: z.string().max(120).nullable(),
});

export const updatePreferencesSchema = z.object({
  pushNotifications: z.boolean().optional(),
  emailNotifications: z.boolean().optional(),
  bookingReminders: z.boolean().optional(),
});

export const registerDeviceSchema = z.object({
  token: z.string().trim().min(1).max(512),
  platform: z.enum(['ios', 'android']),
});

export const qrVerifySchema = z.object({
  token: z.string().trim().min(1).max(512),
});

export const idVerificationReviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(1000).optional(),
});

export const idVerificationQueueQuerySchema = z.object({
  status: z.enum(['not_submitted', 'submitted', 'verified', 'rejected']).default('submitted'),
});

// Step-up proof for DELETE /api/me: exactly one of password, a fresh OAuth
// assertion, or an emailed re-auth token. Absent entirely = the client is
// probing (the 403 lists acceptable methods) or resuming an existing
// deletion request.
export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(256).optional(),
  provider: z.enum(['google', 'apple']).optional(),
  idToken: z.string().min(1).optional(),
  nonce: z.string().min(1).max(200).optional(),
  reauthToken: z.string().min(1).max(200).optional(),
});
