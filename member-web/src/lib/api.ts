/**
 * Typed API client for the member app.
 *
 * Sessions are httpOnly cookies (never tokens in JS): every request carries
 * `credentials: 'include'`, and auth calls add `X-Client-Type: web` so the
 * backend issues cookies instead of body tokens. Session truth is always
 * `GET /api/auth/me`; auth mutation responses are only used for their
 * success/failure signal.
 *
 * In dev, Vite proxies /api/* to the API server (see vite.config.ts).
 * In production the API container serves this bundle same-origin.
 *
 * Flow packages extend the `api` object below with their own endpoint
 * groups; keep it organized by domain with a comment per group.
 */
import { API_URL } from './env';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The authenticated caller, as returned by GET /api/auth/me. */
export interface Principal {
  userId: string;
  email: string;
  emailVerified: boolean;
  staffRole: 'staff' | 'admin' | null;
  memberId: string | null;
  client: string;
}

/** Serialized identity user returned in auth mutation bodies (no tokens on web). */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: string | null;
  staffRole: 'staff' | 'admin' | null;
}

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

export interface OAuthAppleInput {
  identityToken: string;
  nonce: string;
  authorizationCode?: string;
  fullName?: { givenName?: string; familyName?: string };
}

// ── Plans & membership types (W1 onboarding; W6 account reuses these) ──

export type BillingInterval = 'month' | 'year';

/**
 * A membership plan row from the public catalog (GET /api/plans). Plans are
 * per-billing-period rows: "Member monthly" and "Member annual" are two rows
 * sharing a tier, keyed by their Stripe price.
 */
export interface Plan {
  id: string;
  name: string;
  stripePriceId: string;
  amountCents: number;
  interval: BillingInterval;
  tier: 'member' | 'pro';
  inviteOnly: boolean;
  features: string[];
  sortOrder: number;
  active: boolean;
}

/** Stripe subscription statuses, stored verbatim by the backend. */
export type MembershipStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

export interface MembershipPlanSummary {
  id: string;
  name: string;
  amountCents: number;
  interval: BillingInterval;
  tier: string;
}

/** The member's current membership as serialized by the /api/me endpoints. */
export interface MembershipSummary {
  id: string;
  status: MembershipStatus;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  plan: MembershipPlanSummary | null;
  pendingPlan: { id: string; name: string } | null;
  pendingPlanEffectiveAt: string | null;
}

export interface SubscribeMembershipResult {
  subscriptionId: string;
  /**
   * Confirmation client secret for the subscription's first invoice; the
   * Payment Element mounts on it and stripe.confirmPayment() confirms it.
   * Null only when Stripe has nothing to collect for the invoice.
   */
  clientSecret: string | null;
  customerId: string;
  /** Minted for the mobile PaymentSheet; unused on web. */
  ephemeralKeySecret: string;
}

// ── Identity verification types (W1 onboarding; staff review is admin-web) ──

export type IdVerificationStatus = 'not_submitted' | 'submitted' | 'verified' | 'rejected';

export interface IdVerificationView {
  status: IdVerificationStatus;
  hasPhoto: boolean;
  skippedAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  note: string | null;
}

// ── Venue types (public config; see lib/venue.ts for the query + hook) ──

/**
 * GET /api/venue: the venue's IANA timezone, the wall clock every slot,
 * booking horizon, "today" computation, and ledger month lives on. Clients
 * must anchor date math on this zone, never the device zone.
 */
export interface VenueInfo {
  timezone: string;
}

// ── Booking types (W3 booking; W2 home and W4 reservation detail reuse
//    these, since every surface renders the same serialized reservation) ──

export type MemberTier = 'member' | 'pro';

/** A bookable amenity type row from GET /api/resource-types. */
export interface ResourceTypeSummary {
  code: string;
  name: string;
  /** Grid step in minutes (30 for courts). */
  slotDurationMinutes: number;
  /** Operating hours as minutes from venue-local midnight; end may pass 1440. */
  opStartMinutes: number;
  opEndMinutes: number;
  hourlyRateCents: number;
  /** Booking horizon: today + this many days. */
  maxAdvanceDays: number;
  minTier: MemberTier;
  /** True when the viewer's tier cannot book this type (PRO gate). */
  locked: boolean;
  /** Currently free-to-book units right now, aggregated across resources. */
  resourceCount: number;
  icon: string;
}

/** One bookable grid slot. `start` is a venue wall-clock "HH:MM" label
    (hours may reach 24+ for past-midnight slots); `startsAt` the instant. */
export interface AvailabilitySlot {
  start: string;
  startsAt: string;
}

/** Bookable slots for one venue-local date, taken times simply absent. */
export interface AvailabilityDay {
  date: string;
  slots: AvailabilitySlot[];
}

export interface ReservationQuote {
  typeCode: string;
  date: string;
  slots: string[];
  durationMinutes: number;
  hourlyRateCents: number;
  totalCents: number;
}

export type ReservationStatus = 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
export type ReservationParticipantStatus = 'confirmed' | 'pending' | 'declined' | 'withdrawn';

export interface ReservationParticipant {
  memberId: string;
  firstName: string;
  lastName: string;
  role: 'organizer' | 'guest';
  status: ReservationParticipantStatus;
  invitedById: string | null;
}

/** A reschedule-grow awaiting its delta payment (W4 renders this). */
export interface ReservationPendingChange {
  date: string;
  startTime: string;
  endTime: string;
  deltaCents: number;
  expiresAt: string;
}

/**
 * The serialized reservation every member surface consumes (checkout,
 * confirmation, W2 home cards, W4 detail). Times are venue wall-clock
 * "HH:MM" labels plus ISO instants; `resource` is the server-assigned court.
 */
export interface Reservation {
  id: string;
  /** Human booking reference ("BK-000123"), shown as #BK-000123. */
  reference: string;
  typeCode: string;
  typeName: string;
  resource: { id: string; name: string };
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: ReservationStatus;
  hourlyRateCents: number;
  amountPaidCents: number;
  clubId: string | null;
  seriesId: string | null;
  weekly: boolean;
  createdByAdmin: boolean;
  participants: ReservationParticipant[];
  pendingChange: ReservationPendingChange | null;
  myParticipation?: {
    role: 'organizer' | 'guest';
    status: ReservationParticipantStatus;
    invitedByName: string | null;
    invitedByFirstName: string | null;
  };
}

/** What the viewer may do on a reservation (GET /api/reservations/:id). */
export interface ReservationViewer {
  role: 'organizer' | 'guest';
  status: string;
  canInvite: boolean;
  canManage: boolean;
  canRespond: boolean;
}

/**
 * POST /api/reservations: the slot is HELD (pending_payment, expires at
 * holdExpiresAt) with a server-assigned court, and the booking
 * PaymentIntent's client secret is returned for the Payment Element.
 */
export interface CreateReservationResult {
  reservation: Reservation;
  totalCents: number;
  clientSecret: string | null;
  holdExpiresAt: string | null;
}

export interface ReservationInvitees {
  memberIds?: string[];
  /** Club chips; each expands server-side to the club's current roster. */
  clubIds?: string[];
}

/**
 * POST /api/reservations/:id/reschedule-quote: the money delta of moving
 * the reservation to the new slots, priced at the SNAPSHOT hourly rate.
 * Positive deltaCents is an additional charge; negative is a refund.
 */
export interface RescheduleQuote {
  date: string;
  slots: string[];
  durationMinutes: number;
  newTotalCents: number;
  netPaidCents: number;
  deltaCents: number;
}

/**
 * PATCH /api/reservations/:id (reschedule). Shrink/equal applies
 * immediately (clientSecret null, deltaCents <= 0, refund already on its
 * way). Grow parks the change as `reservation.pendingChange` and returns
 * the delta PaymentIntent's clientSecret; the move applies only once the
 * delta is paid and POST :id/confirm settles it.
 */
export interface RescheduleResult {
  reservation: Reservation;
  deltaCents: number;
  clientSecret: string | null;
}

/** Member directory hit (GET /api/members/search); names only, no emails. */
export interface MemberSearchResult {
  id: string;
  memberNumber: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  avatarUrl: string | null;
}

// ── Club types (W3 consumes list + roster for invite chips; W5 owns the rest) ──

export type ClubRole = 'owner' | 'member';

export interface ClubSummary {
  id: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  memberCount: number;
}

export interface MyClub extends ClubSummary {
  myRole: ClubRole;
  joinedAt: string;
  createdAt: string;
}

export interface ClubRosterEntry {
  memberId: string;
  memberNumber: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: ClubRole;
  joinedAt: string;
}

/**
 * What the viewer may do on a club (GET /api/clubs/:id). The backend
 * derives these from the viewer's role; the client renders actions from
 * the flags, never from the role directly.
 */
export interface ClubPermissionFlags {
  canEdit: boolean;
  canDelete: boolean;
  canManageMembers: boolean;
  canInvite: boolean;
  /** True only when leaving will succeed (an owner must transfer first). */
  canLeave: boolean;
}

export interface ClubDetail extends ClubSummary {
  myRole: ClubRole;
  permissions: ClubPermissionFlags;
  createdAt: string;
  updatedAt: string;
}

/**
 * A club-linked reservation in the GROUP ACTIVITY feed
 * (GET /api/clubs/:id/activity). Club membership is not booking
 * participation, so this is the reduced non-participant projection:
 * counts and the organizer only, never the full roster.
 */
export interface ClubActivityItem {
  id: string;
  reference: string;
  typeCode: string;
  typeName: string;
  resource: { id: string; name: string };
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: ReservationStatus;
  clubId: string | null;
  seriesId: string | null;
  organizer: { memberId: string; firstName: string; lastName: string } | null;
  /** Confirmed attendees (organizer included): the feed's "N players". */
  confirmedCount: number;
  /** The viewer's own participation, when they are on the reservation. */
  myParticipation: {
    role: 'organizer' | 'guest';
    status: ReservationParticipantStatus;
    invitedByName: string | null;
  } | null;
}

/**
 * POST /api/clubs/:id/invite-link. The raw token leaves the API exactly
 * once, here; the client builds the share URL and QR payload from it.
 */
export interface ClubInviteLink {
  token: string;
  expiresAt: string | null;
  maxUses: number | null;
}

export interface ClubInvitePreview {
  club: ClubSummary;
  alreadyMember: boolean;
}

export interface ClubJoinResult {
  club: ClubSummary;
  joined: boolean;
  alreadyMember: boolean;
}

// ── Home types (W2; GET /api/me/home is the one aggregated home read) ──

/** The member profile block on the home payload (serializeMember). */
export interface HomeMember {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  memberNumber: string;
  displayName: string | null;
  avatarUrl: string | null;
  memberSince: string;
  membership: {
    id: string;
    status: MembershipStatus;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    plan: { id: string; name: string; amountCents: number; interval: BillingInterval };
  } | null;
}

/**
 * Greeting computed in the VIEWER'S clock: the client sends its IANA zone
 * as `?tz=`; the backend falls back to the venue zone when it is invalid.
 */
export interface HomeGreeting {
  firstName: string;
  timeOfDay: 'morning' | 'afternoon' | 'evening';
  timezone: string;
}

/** A spotlight club event card (image, title, when). */
export interface SpotlightEvent {
  id: string;
  title: string;
  imageUrl: string | null;
  details: string | null;
  startsAt: string;
  endsAt: string;
  /** The venue zone the event times are anchored in; format with it. */
  timezone: string;
  active: boolean;
  courts: { id: string; name: string }[];
}

/** The deterministic "AI suggestion" quick-book slot (habit or fallback). */
export interface QuickBookSuggestion {
  typeCode: string;
  typeName: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  hourlyRateCents: number;
  /** Why this slot, e.g. "You often book Badminton Court on Sundays ...". */
  reason: string;
}

/** Empty-state amenity summary row (present ONLY in the empty state). */
export interface HomeAmenitySummary {
  typeCode: string;
  typeName: string;
  hourlyRateCents: number;
  resourceCount: number;
  availableSlotsToday: number;
  locked: boolean;
}

/** A pending club invitation awaiting the viewer's response. */
export interface ClubInvitation {
  id: string;
  club: ClubSummary;
  invitedBy: { memberId: string; firstName: string; lastName: string } | null;
  createdAt: string;
}

/**
 * GET /api/me/home. `upcomingReservations` are upcoming where the viewer is
 * confirmed; `pendingInvitations` where their participation is pending
 * (rendered distinctly with inline Accept/Decline; `myParticipation`
 * carries the inviter's first name). `amenities` is non-null ONLY in the
 * empty state (nothing upcoming, no reservation invitations). The response
 * also carries a legacy `upcomingBookings` list for the old member portal,
 * which this client ignores.
 */
export interface HomeFeed {
  member: HomeMember;
  greeting: HomeGreeting;
  spotlightEvents: SpotlightEvent[];
  upcomingReservations: Reservation[];
  pendingInvitations: Reservation[];
  clubInvitations: ClubInvitation[];
  quickBook: QuickBookSuggestion | null;
  amenities: HomeAmenitySummary[] | null;
}

/** GET /api/me/qr: a short-lived signed token (60s TTL) for the member
    card QR; refetch before `expiresAt`, never cache across opens. */
export interface MemberQrToken {
  token: string;
  expiresAt: string;
  ttlSeconds: number;
}

// ── Account types (W6: profile, preferences, billing, deletion) ──

/** Lifetime confirmed-courts activity stats (GET /api/me/profile). */
export interface LifetimeStats {
  courtsBooked: number;
  /** Decimal hours (30-minute slots give .5 granularity). */
  badmintonHours: number;
  tennisHours: number;
}

/**
 * GET /api/me/profile. `member` is the same serializeMember shape the home
 * feed carries (HomeMember); `plans` is the raw catalog the route bundles
 * (unused by the account screens, typed for completeness).
 */
export interface MyProfile {
  member: HomeMember;
  plans: Plan[];
  stats: LifetimeStats;
}

/** GET/PUT /api/me/preferences. Absent row = all true server-side. */
export interface NotificationPreferences {
  pushNotifications: boolean;
  emailNotifications: boolean;
  bookingReminders: boolean;
}

/** A stored card as serialized by GET /api/me/billing. */
export interface PaymentMethodSummary {
  /** The Stripe payment-method id (pm_...). */
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

/** One venue-local month bucket of the billing ledger, newest first. */
export interface BillingMonth {
  /** "YYYY-MM" in the venue timezone. */
  month: string;
  debitCents: number;
  creditCents: number;
  /** debits minus credits; positive means the member paid on net. */
  netCents: number;
  count: number;
}

/**
 * GET /api/me/billing: the full billing screen read (W6). W1 reads only
 * `membership` from the same endpoint via getMyMembership.
 */
export interface BillingOverview {
  membership: MembershipSummary | null;
  defaultPaymentMethod: PaymentMethodSummary | null;
  paymentMethods: PaymentMethodSummary[];
  months: BillingMonth[];
}

export type TransactionKind =
  | 'membership_fee'
  | 'booking_fee'
  | 'booking_refund'
  | 'membership_refund'
  | 'adjustment';
export type TransactionStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

/** One ledger row (GET /api/me/billing/transactions?month=YYYY-MM). */
export interface BillingTransaction {
  id: string;
  kind: TransactionKind;
  /** debit = the member paid; credit = money back (refund). */
  direction: 'debit' | 'credit';
  /** Always positive; direction carries the sign. */
  amountCents: number;
  taxCents: number;
  currency: string;
  status: TransactionStatus;
  occurredAt: string;
  description: string;
  receiptUrl: string | null;
  reservationId: string | null;
}

/** POST /api/me/payment-methods/setup-intent ("edit payment method"). */
export interface SetupIntentResult {
  clientSecret: string;
  customerId: string;
  /** Minted for the mobile PaymentSheet; unused on web. */
  ephemeralKeySecret: string;
}

/**
 * Latest-invoice collection state on POST /api/me/membership/confirm:
 * tells an async charge still clearing (processing) from a failed one
 * (requires_payment_method) while the membership status still reads
 * incomplete.
 */
export type MembershipPaymentStatus =
  | 'succeeded'
  | 'processing'
  | 'requires_action'
  | 'requires_payment_method'
  | 'canceled'
  | 'unknown';

/**
 * POST /api/me/membership/change. Upgrades (tier up, monthly -> annual,
 * price up) apply immediately with prorations; `clientSecret` is non-null
 * when the proration invoice needs payment/SCA (confirm it, then read back
 * with confirmMembership). Downgrades schedule at period end, no refund.
 */
export interface ChangeMembershipResult {
  kind: 'upgraded' | 'downgrade_scheduled';
  clientSecret: string | null;
  pendingPlanEffectiveAt: string | null;
  membership: MembershipSummary | null;
}

/** DELETE /api/me/membership (default at period end; ?now=true immediate). */
export interface CancelMembershipResult {
  canceledImmediately: boolean;
  effectiveAt: string;
  membership: MembershipSummary | null;
}

/** GET /api/me/auth-identities: how this account can prove itself. */
export interface AuthIdentities {
  hasPassword: boolean;
  identities: {
    provider: 'google' | 'apple';
    email: string | null;
    isPrivateRelay: boolean;
    linkedAt: string;
    lastUsedAt: string | null;
  }[];
}

/** Step-up methods DELETE /api/me accepts (403 STEP_UP_REQUIRED lists them). */
export type StepUpMethod = 'password' | 'oauth' | 'reauth_email';

/**
 * Exactly one step-up proof for DELETE /api/me: the current password, a
 * fresh OAuth assertion, or the emailed re-auth code from
 * POST /api/me/reauth-email.
 */
export type DeleteAccountProof =
  | { password: string }
  | { provider: 'google' | 'apple'; idToken: string; nonce: string }
  | { reauthToken: string };

/**
 * 202 from DELETE /api/me. The deletion saga is resumable server-side;
 * whatever the status, the client signs out locally. Blocked deletions
 * (open dispute, refund in flight) answer 409 DELETION_BLOCKED with
 * `details.reasons` instead.
 */
export interface DeleteAccountResult {
  status: 'completed' | 'in_progress' | 'failed';
}

function normalizeJsonResponse(text: string) {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isAuthPath(path: string): boolean {
  return path.startsWith('/api/auth/');
}

/**
 * Single-flight session refresh. When any request hits a 401 we try one
 * cookie refresh (POST /api/auth/refresh rotates the httpOnly cookies) and
 * retry the request once; concurrent 401s share the same refresh attempt.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Client-Type': 'web' },
        body: '{}',
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function performRequest(path: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers);
  const isFormDataBody = typeof FormData !== 'undefined' && options?.body instanceof FormData;

  if (!isFormDataBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (isAuthPath(path)) {
    // The backend derives cookie-vs-bearer transport from this header.
    headers.set('X-Client-Type', 'web');
  }

  return fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...options,
    headers,
  });
}

/**
 * Core request pipeline. Flow packages define their endpoints on `api`
 * below in terms of this helper; avoid calling it ad hoc from components.
 */
export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let res = await performRequest(path, options);

  // Expired access cookie: refresh once and retry. Auth endpoints are
  // excluded; /me returning 401 means "signed out", not "retry".
  if (res.status === 401 && !isAuthPath(path)) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await performRequest(path, options);
    }
  }

  const text = await res.text();
  const json = normalizeJsonResponse(text);

  if (!res.ok) {
    throw new ApiError(
      json.error?.code ?? 'UNKNOWN',
      json.error?.message ?? 'Request failed',
      res.status,
      json.error?.details,
    );
  }

  return json.data;
}

export const api = {
  // ── Session ──
  getMe: () => request<Principal | null>('/api/auth/me'),
  signOut: () => request<{ signedOut: true }>('/api/auth/signout', { method: 'POST' }),

  // ── Password auth ──
  signUp: (input: SignUpInput) =>
    request<{ user: AuthUser }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  signIn: (input: { email: string; password: string }) =>
    request<{ user: AuthUser }>('/api/auth/signin', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ── OAuth (Google Identity Services / Sign in with Apple JS) ──
  oauthNonce: () =>
    request<{ nonce: string; expiresAt: string }>('/api/auth/oauth/nonce', { method: 'POST' }),
  oauthGoogle: (input: { idToken: string; nonce: string }) =>
    request<{ user: AuthUser }>('/api/auth/oauth/google', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  oauthApple: (input: OAuthAppleInput) =>
    request<{ user: AuthUser }>('/api/auth/oauth/apple', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ── Magic link ──
  requestMagicLink: (email: string) =>
    request<{ sent: true }>('/api/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  // ── Password reset ──
  forgotPassword: (email: string) =>
    request<{ sent: true }>('/api/auth/password/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  resetPassword: (input: { token: string; password: string }) =>
    request<{ reset: true }>('/api/auth/password/reset', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ── Email verification ──
  verifyEmail: (token: string) =>
    request<{ verified: true; memberClaimed: boolean }>('/api/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  resendVerification: () =>
    request<{ sent: true }>('/api/auth/email/resend', { method: 'POST' }),

  // ── Plans & membership ──
  getPlans: () => request<Plan[]>('/api/plans'),
  /**
   * The member's current membership AND the rest of the billing screen
   * (default payment method, ledger months). One endpoint, one query key
   * (['membership']): W1 reads `membership` for onboarding gating, W6
   * reads the full overview for the billing page.
   */
  getMyMembership: () => request<BillingOverview>('/api/me/billing'),
  /**
   * Subscription-first purchase: creates (or re-fetches, on retry of the
   * same plan) an incomplete Stripe subscription and returns the client
   * secret to confirm. Terms acceptance is recorded server-side from
   * termsVersion before the subscription exists.
   */
  subscribeMembership: (input: { planId: string; termsVersion: string }) =>
    request<SubscribeMembershipResult>('/api/me/membership/subscribe', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Synchronous read-back after payment; never waits on a webhook. */
  confirmMembership: () =>
    request<{
      activated: boolean;
      paymentStatus: MembershipPaymentStatus;
      membership: MembershipSummary | null;
    }>('/api/me/membership/confirm', { method: 'POST', body: '{}' }),

  // ── Identity verification (private upload: authenticated endpoint, never /uploads) ──
  getIdVerification: () => request<IdVerificationView>('/api/me/id-verification'),
  uploadIdPhoto: (photo: File) => {
    const body = new FormData();
    body.append('photo', photo);
    return request<IdVerificationView>('/api/me/id-verification/photo', {
      method: 'POST',
      body,
    });
  },
  submitIdVerification: () =>
    request<IdVerificationView>('/api/me/id-verification/submit', {
      method: 'POST',
      body: '{}',
    }),
  skipIdVerification: () =>
    request<IdVerificationView>('/api/me/id-verification/skip', {
      method: 'POST',
      body: '{}',
    }),

  // ── Venue (public; the venue timezone all date math anchors on) ──
  getVenue: () => request<VenueInfo>('/api/venue'),

  // ── Booking (W3; the reservation reads/mutations are shared with W4) ──
  getResourceTypes: () => request<ResourceTypeSummary[]>('/api/resource-types'),
  /**
   * Bookable slots for a date range (default 1 day). Aggregated by type:
   * a slot is listed when ANY unit of the type is free; the specific court
   * is assigned server-side at reservation create.
   */
  getAvailability: (typeCode: string, params: { date: string; days?: number }) => {
    const query = new URLSearchParams({ date: params.date });
    if (params.days !== undefined) query.set('days', String(params.days));
    return request<AvailabilityDay[]>(
      `/api/resource-types/${encodeURIComponent(typeCode)}/availability?${query}`,
    );
  },
  /** Server-priced quote; also validates one court can host the whole set. */
  quoteReservation: (input: { typeCode: string; date: string; slots: string[] }) =>
    request<ReservationQuote>('/api/reservations/quote', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Holds the slot (returns the assigned court + Stripe client secret). */
  createReservation: (input: {
    typeCode: string;
    date: string;
    slots: string[];
    invitees?: ReservationInvitees;
  }) =>
    request<CreateReservationResult>('/api/reservations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /**
   * The "payment succeeded" read-back: asserts the PaymentIntent captured
   * and flips the hold to confirmed. Idempotent; never waits on a webhook.
   */
  confirmReservation: (id: string) =>
    request<Reservation>(`/api/reservations/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      body: '{}',
    }),
  getReservation: (id: string) =>
    request<Reservation & { viewer: ReservationViewer }>(
      `/api/reservations/${encodeURIComponent(id)}`,
    ),
  /** Cancels a reservation; on an unpaid hold this releases the slot. */
  cancelReservation: (id: string) =>
    request<{ cancelled: boolean; refundCents: number }>(
      `/api/reservations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  addReservationParticipants: (id: string, invitees: ReservationInvitees) =>
    request<{ invited: string[] }>(
      `/api/reservations/${encodeURIComponent(id)}/participants`,
      { method: 'POST', body: JSON.stringify(invitees) },
    ),
  /** Organizer removes a guest from the roster (never the organizer row). */
  removeReservationParticipant: (id: string, memberId: string) =>
    request<{ removed: true }>(
      `/api/reservations/${encodeURIComponent(id)}/participants/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' },
    ),
  /**
   * Invitation response (W4 detail; W2 home renders the same actions).
   * accept: pending -> confirmed. decline: pending -> declined, or
   * confirmed -> withdrawn (withdraw after accept). Idempotent server-side;
   * declined/withdrawn + accept is rejected (re-invite required).
   */
  respondToReservation: (id: string, response: 'accept' | 'decline') =>
    request<{ status: ReservationParticipantStatus }>(
      `/api/reservations/${encodeURIComponent(id)}/respond`,
      { method: 'POST', body: JSON.stringify({ response }) },
    ),
  /** Prices a reschedule without applying it (delta at the snapshot rate). */
  rescheduleQuote: (id: string, change: { date: string; slots: string[] }) =>
    request<RescheduleQuote>(
      `/api/reservations/${encodeURIComponent(id)}/reschedule-quote`,
      { method: 'POST', body: JSON.stringify(change) },
    ),
  /**
   * Reschedule (organizer, confirmed reservations). Confirmed guests are
   * reset to pending when the move applies; see RescheduleResult for the
   * two money paths.
   */
  rescheduleReservation: (id: string, change: { date: string; slots: string[] }) =>
    request<RescheduleResult>(`/api/reservations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(change),
    }),
  /**
   * Member directory search by name prefix or member number. An empty
   * query serves the default alphabetical directory page (the invite
   * pickers' pre-search list, which excludes the caller server-side).
   */
  searchMembers: (q: string, limit = 10) => {
    const query = new URLSearchParams({ limit: String(limit) });
    const trimmed = q.trim();
    if (trimmed) query.set('q', trimmed);
    return request<MemberSearchResult[]>(`/api/members/search?${query}`);
  },

  // ── Clubs (W3 reads list + roster for invite chips; W5 owns the rest) ──
  getMyClubs: () => request<MyClub[]>('/api/me/clubs'),
  /** Viewer-scoped detail; outsiders get the 404 shape on purpose. */
  getClub: (clubId: string) =>
    request<ClubDetail>(`/api/clubs/${encodeURIComponent(clubId)}`),
  /** Creates the club (creator becomes owner) and sends the initial
      invitations; invitees must accept before they join the roster. */
  createClub: (input: { name: string; description?: string; inviteeMemberIds?: string[] }) =>
    request<{ club: ClubSummary; invited: string[] }>('/api/clubs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Owner edit. `coverImageUrl: null` removes the cover; a NEW cover goes
      through the multipart upload endpoint, never this PATCH. */
  updateClub: (
    clubId: string,
    input: { name?: string; description?: string | null; coverImageUrl?: null },
  ) =>
    request<ClubSummary>(`/api/clubs/${encodeURIComponent(clubId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteClub: (clubId: string) =>
    request<{ deleted: boolean }>(`/api/clubs/${encodeURIComponent(clubId)}`, {
      method: 'DELETE',
    }),
  /** Owner cover upload (multipart; JPG/PNG/WebP/GIF, 5 MB max). */
  uploadClubCover: (clubId: string, image: File) => {
    const body = new FormData();
    body.append('image', image);
    return request<ClubSummary>(`/api/clubs/${encodeURIComponent(clubId)}/cover-image`, {
      method: 'POST',
      body,
    });
  },
  /** Leave a club (members only; the owner answers 409 OWNER_MUST_TRANSFER). */
  leaveClub: (clubId: string) =>
    request<{ left: boolean }>(`/api/clubs/${encodeURIComponent(clubId)}/leave`, {
      method: 'POST',
      body: '{}',
    }),
  getClubMembers: (clubId: string) =>
    request<ClubRosterEntry[]>(`/api/clubs/${encodeURIComponent(clubId)}/members`),
  /** Owner role change; `role: 'owner'` transfers ownership (the previous
      owner becomes a member in the same transaction). */
  changeClubMemberRole: (clubId: string, memberId: string, role: ClubRole) =>
    request<{ updated: boolean }>(
      `/api/clubs/${encodeURIComponent(clubId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
    ),
  removeClubMember: (clubId: string, memberId: string) =>
    request<{ removed: boolean }>(
      `/api/clubs/${encodeURIComponent(clubId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' },
    ),
  /** Batch invitations (require acceptance). Members already in the club or
      already holding a live invite are silently skipped; `invited` lists
      who actually got one. */
  inviteClubMembers: (clubId: string, memberIds: string[]) =>
    request<{ invited: string[] }>(`/api/clubs/${encodeURIComponent(clubId)}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ memberIds }),
    }),
  /** The viewer's pending club invitations (same shape as the home feed's). */
  getMyClubInvitations: () => request<ClubInvitation[]>('/api/me/club-invitations'),
  /**
   * Accept or decline a pending club invitation. Idempotent when the state
   * already agrees; a stale invitation answers 409 INVALID_INVITATION_STATE
   * or 404 (not the invitee / gone).
   */
  respondToClubInvitation: (id: string, response: 'accept' | 'decline') =>
    request<{ status: string; clubId: string }>(
      `/api/club-invitations/${encodeURIComponent(id)}/respond`,
      { method: 'POST', body: JSON.stringify({ response }) },
    ),
  /** Mint a share link (any member). `rotate: true` (owner only) also
      revokes every other active link, killing a leaked URL. */
  createClubInviteLink: (
    clubId: string,
    options: { expiresInDays?: number; maxUses?: number; rotate?: boolean } = {},
  ) =>
    request<ClubInviteLink>(`/api/clubs/${encodeURIComponent(clubId)}/invite-link`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  /** Resolve a share-link token to a club preview for the join screen.
      Dead links (revoked/expired/used up) answer 410 INVITE_LINK_INVALID. */
  previewClubInvite: (token: string) =>
    request<ClubInvitePreview>('/api/clubs/invite-preview', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  /** Join via share link. Idempotent for existing members. */
  joinClub: (token: string) =>
    request<ClubJoinResult>('/api/clubs/join', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  /** GROUP ACTIVITY: the club's linked reservations (members only). */
  getClubActivity: (clubId: string, filter: 'upcoming' | 'past' | 'all' = 'all') =>
    request<ClubActivityItem[]>(
      `/api/clubs/${encodeURIComponent(clubId)}/activity?${new URLSearchParams({ filter })}`,
    ),

  // ── Home (W2) ──
  /** The aggregated home feed; `tz` is the browser IANA zone for the greeting. */
  getHome: (tz?: string) =>
    request<HomeFeed>(`/api/me/home${tz ? `?${new URLSearchParams({ tz })}` : ''}`),
  /** Short-lived member-card QR token (see MemberQrToken). */
  getMemberQr: () => request<MemberQrToken>('/api/me/qr'),

  // ── Account: profile & avatar (W6) ──
  getMyProfile: () => request<MyProfile>('/api/me/profile'),
  /** Edits only the display name; null (or blank, normalized server-side)
      clears it back to the "First Last" fallback. */
  updateMyProfile: (input: { displayName: string | null }) =>
    request<{ member: HomeMember }>('/api/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  /** Replaces the avatar (multipart; normalized to a 512px square webp). */
  uploadAvatar: (image: File) => {
    const body = new FormData();
    body.append('image', image);
    return request<{ avatarUrl: string }>('/api/me/avatar', { method: 'POST', body });
  },

  // ── Account: notification preferences (W6) ──
  getPreferences: () => request<NotificationPreferences>('/api/me/preferences'),
  /** Partial update: send ONLY the toggled key, so a stale client saving
      one switch can never clobber the others. Returns the full row. */
  updatePreferences: (changes: Partial<NotificationPreferences>) =>
    request<NotificationPreferences>('/api/me/preferences', {
      method: 'PUT',
      body: JSON.stringify(changes),
    }),

  // ── Billing (W6; the overview itself is getMyMembership above) ──
  /** One venue-local month of ledger rows, loaded on expand. */
  getBillingTransactions: (month: string) =>
    request<{ month: string; transactions: BillingTransaction[] }>(
      `/api/me/billing/transactions?${new URLSearchParams({ month })}`,
    ),
  /** "Edit payment method": a setup-mode client secret for the Payment Element. */
  createPaymentMethodSetupIntent: () =>
    request<SetupIntentResult>('/api/me/payment-methods/setup-intent', {
      method: 'POST',
      body: '{}',
    }),
  /** Default on BOTH the Stripe customer and the live subscription; a pm_
      id not owned by the caller's own customer 404s. */
  setDefaultPaymentMethod: (paymentMethodId: string) =>
    request<{ default: string }>(
      `/api/me/payment-methods/${encodeURIComponent(paymentMethodId)}/default`,
      { method: 'POST', body: '{}' },
    ),

  // ── Membership change & cancel (W6) ──
  changeMembership: (planId: string) =>
    request<ChangeMembershipResult>('/api/me/membership/change', {
      method: 'POST',
      body: JSON.stringify({ planId }),
    }),
  /** Default cancels at period end; `now` cancels immediately, no refund. */
  cancelMembership: (options: { now?: boolean } = {}) =>
    request<CancelMembershipResult>(
      `/api/me/membership${options.now ? '?now=true' : ''}`,
      { method: 'DELETE' },
    ),

  // ── Account deletion (W6; step-up gated per the backend contract) ──
  /** Which step-up proofs this account can produce (password vs code). */
  getAuthIdentities: () => request<AuthIdentities>('/api/me/auth-identities'),
  /** Emails a single-use re-auth code (10 min TTL, session-bound);
      rate-limited to 3 per 15 minutes. */
  requestReauthEmail: () =>
    request<{ sent: true }>('/api/me/reauth-email', { method: 'POST', body: '{}' }),
  /**
   * Starts (or resumes) the deletion saga. Requires exactly one step-up
   * proof; failures surface as ApiError codes STEP_UP_FAILED (bad proof),
   * DELETION_BLOCKED (409, details.reasons), or STEP_UP_REQUIRED
   * (details.acceptableMethods). Rate-limited to 5 per 15 minutes.
   */
  deleteAccount: (proof: DeleteAccountProof) =>
    request<DeleteAccountResult>('/api/me', {
      method: 'DELETE',
      body: JSON.stringify(proof),
    }),
};
