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

/** Member directory hit (GET /api/members/search); names only, no emails. */
export interface MemberSearchResult {
  id: string;
  memberNumber: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  avatarUrl: string | null;
}

// ── Club types (W3 consumes list + roster for invite chips; W5 widens) ──

export interface ClubSummary {
  id: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  memberCount: number;
}

export interface MyClub extends ClubSummary {
  myRole: string;
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
  role: string;
  joinedAt: string;
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
   * The member's current membership. Reads GET /api/me/billing (the one
   * membership read endpoint); W6 widens the typing for the full billing
   * screen (payment methods, ledger months) when it builds that page.
   */
  getMyMembership: () => request<{ membership: MembershipSummary | null }>('/api/me/billing'),
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
    request<{ activated: boolean; membership: MembershipSummary | null }>(
      '/api/me/membership/confirm',
      { method: 'POST', body: '{}' },
    ),

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
  /** Member directory search by name prefix or member number (min 1 char). */
  searchMembers: (q: string, limit = 10) => {
    const query = new URLSearchParams({ q, limit: String(limit) });
    return request<MemberSearchResult[]>(`/api/members/search?${query}`);
  },

  // ── Clubs (W3 reads list + roster for invite chips; W5 owns the rest) ──
  getMyClubs: () => request<MyClub[]>('/api/me/clubs'),
  getClubMembers: (clubId: string) =>
    request<ClubRosterEntry[]>(`/api/clubs/${encodeURIComponent(clubId)}/members`),
};
