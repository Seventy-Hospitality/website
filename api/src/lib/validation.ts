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

export const createCheckoutSchema = z.object({
  memberId: z.string().min(1),
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

// ── Bookings ──

export const createBookingSchema = z.object({
  memberId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
});

export const createSelfBookingSchema = z.object({
  facilityType: z.enum(['court', 'shower']),
  facilityId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
});

export const availabilityQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const createFacilitySchema = z.object({
  name: z.string().min(1).max(100),
  slotDurationMinutes: z.number().int().positive().optional(),
  operatingHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  operatingHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  maxAdvanceDays: z.number().int().positive().optional(),
  maxBookingsPerMemberPerDay: z.number().int().positive().optional(),
  cancellationDeadlineMinutes: z.number().int().min(0).optional(),
});

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
