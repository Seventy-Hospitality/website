/**
 * Typed API client for the Club70 mobile app.
 *
 * Transport: bearer tokens (never cookies). The access token rides
 * `Authorization: Bearer` on every request; auth calls (`/api/auth/*`) add
 * `X-Client-Type: mobile` so the backend issues the body token pair instead
 * of cookies. Session truth is `GET /api/auth/me` (the Principal); auth
 * mutation bodies carry the token pair the SessionProvider persists.
 *
 * On a 401 (non-auth path) the pipeline performs ONE single-flight refresh
 * (`POST /api/auth/refresh { refreshToken }`) and retries the request once;
 * concurrent 401s share the same refresh. Token storage and the "refresh
 * failed -> sign out" reaction are injected via an AuthBridge so the logic is
 * testable and the SessionProvider owns the React/SecureStore state.
 *
 * Flow packages (M1..M6) extend the `api` object below with their own
 * endpoint groups; keep it organized by domain with a comment per group.
 * Everything rides the shared `request()` helper.
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

// ── Session / auth types ──

/** The authenticated caller, as returned by GET /api/auth/me. */
export interface Principal {
  userId: string;
  email: string;
  emailVerified: boolean;
  staffRole: 'staff' | 'admin' | null;
  memberId: string | null;
  client: string;
}

/** Back-compat alias for the historical name. */
export type SessionUser = Principal;

/** Serialized identity user in auth mutation bodies. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: string | null;
  staffRole: 'staff' | 'admin' | null;
}

/** The bearer token pair the mobile client receives from every auth call. */
export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** Full auth mutation response for the mobile (bearer) client. */
export interface IssuedSession extends SessionTokens {
  user: AuthUser;
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

// ── Plans & membership types ──

export type BillingInterval = 'month' | 'year';

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
  /** Confirmation client secret for the first invoice; null when nothing to collect. */
  clientSecret: string | null;
  customerId: string;
  /** For the mobile PaymentSheet's ephemeral key. */
  ephemeralKeySecret: string;
}

export type MembershipPaymentStatus =
  | 'succeeded'
  | 'processing'
  | 'requires_action'
  | 'requires_payment_method'
  | 'canceled'
  | 'unknown';

export interface ConfirmMembershipResult {
  activated: boolean;
  paymentStatus: MembershipPaymentStatus;
  membership: MembershipSummary | null;
}

export interface ChangeMembershipResult {
  kind: 'upgraded' | 'downgrade_scheduled';
  clientSecret: string | null;
  pendingPlanEffectiveAt: string | null;
  membership: MembershipSummary | null;
}

export interface CancelMembershipResult {
  canceledImmediately: boolean;
  effectiveAt: string;
  membership: MembershipSummary | null;
}

// ── Identity verification types ──

export type IdVerificationStatus = 'not_submitted' | 'submitted' | 'verified' | 'rejected';

export interface IdVerificationView {
  status: IdVerificationStatus;
  hasPhoto: boolean;
  skippedAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  note: string | null;
}

// ── Onboarding resume state ──

export type OnboardingStep =
  | 'verify-email'
  | 'choose-membership'
  | 'confirm-payment'
  | 'id-verification'
  | 'complete';

export interface OnboardingState {
  emailVerified: boolean;
  membership: { status: MembershipStatus; everLive: boolean } | null;
  idVerification: { status: IdVerificationStatus; skippedAt: string | null } | null;
  nextStep: OnboardingStep;
}

// ── Venue ──

export interface VenueInfo {
  timezone: string;
}

// ── Booking / reservation types (shared across M2 home, M3 booking, M4) ──

export type MemberTier = 'member' | 'pro';

export interface ResourceTypeSummary {
  code: string;
  name: string;
  slotDurationMinutes: number;
  opStartMinutes: number;
  opEndMinutes: number;
  hourlyRateCents: number;
  maxAdvanceDays: number;
  minTier: MemberTier;
  locked: boolean;
  resourceCount: number;
  icon: string;
}

export interface AvailabilitySlot {
  /** Venue wall-clock "HH:MM" (hours may reach 24+ for past-midnight slots). */
  start: string;
  startsAt: string;
}

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

export interface ReservationPendingChange {
  date: string;
  startTime: string;
  endTime: string;
  deltaCents: number;
  expiresAt: string;
}

export interface Reservation {
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

export interface ReservationViewer {
  role: 'organizer' | 'guest';
  status: string;
  canInvite: boolean;
  canManage: boolean;
  canRespond: boolean;
}

export interface CreateReservationResult {
  reservation: Reservation;
  totalCents: number;
  clientSecret: string | null;
  holdExpiresAt: string | null;
}

export interface ReservationInvitees {
  memberIds?: string[];
  clubIds?: string[];
}

export interface RescheduleQuote {
  date: string;
  slots: string[];
  durationMinutes: number;
  newTotalCents: number;
  netPaidCents: number;
  deltaCents: number;
}

export interface RescheduleResult {
  reservation: Reservation;
  deltaCents: number;
  clientSecret: string | null;
}

export interface ReissuePaymentIntentResult {
  reservation: Reservation;
  purpose: string;
  amountCents: number;
  clientSecret: string | null;
  expiresAt: string | null;
  alreadyPaid: boolean;
}

export interface MemberSearchResult {
  id: string;
  memberNumber: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  avatarUrl: string | null;
}

// ── Club types ──

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

export interface ClubPermissionFlags {
  canEdit: boolean;
  canDelete: boolean;
  canManageMembers: boolean;
  canInvite: boolean;
  canLeave: boolean;
}

export interface ClubDetail extends ClubSummary {
  myRole: ClubRole;
  permissions: ClubPermissionFlags;
  createdAt: string;
  updatedAt: string;
}

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
  confirmedCount: number;
  myParticipation: {
    role: 'organizer' | 'guest';
    status: ReservationParticipantStatus;
    invitedByName: string | null;
  } | null;
}

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

// ── Home types ──

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

export interface HomeGreeting {
  firstName: string;
  timeOfDay: 'morning' | 'afternoon' | 'evening';
  timezone: string;
}

export interface SpotlightEvent {
  id: string;
  title: string;
  imageUrl: string | null;
  details: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  active: boolean;
  courts: { id: string; name: string }[];
}

/** Back-compat alias (the existing EventSpotlightCard component). */
export type ClubEvent = SpotlightEvent;

export interface QuickBookSuggestion {
  typeCode: string;
  typeName: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  hourlyRateCents: number;
  reason: string;
}

export interface HomeAmenitySummary {
  typeCode: string;
  typeName: string;
  hourlyRateCents: number;
  resourceCount: number;
  availableSlotsToday: number;
  locked: boolean;
}

export interface ClubInvitation {
  id: string;
  club: ClubSummary;
  invitedBy: { memberId: string; firstName: string; lastName: string } | null;
  createdAt: string;
}

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

export interface MemberQrToken {
  token: string;
  expiresAt: string;
  ttlSeconds: number;
}

// ── Account types ──

export interface LifetimeStats {
  courtsBooked: number;
  badmintonHours: number;
  tennisHours: number;
}

export interface MyProfile {
  member: HomeMember;
  plans: Plan[];
  stats: LifetimeStats;
}

export interface NotificationPreferences {
  pushNotifications: boolean;
  emailNotifications: boolean;
  bookingReminders: boolean;
}

export interface RegisteredDevice {
  token: string;
  platform: 'ios' | 'android';
  registeredAt: string;
}

export interface PaymentMethodSummary {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export interface BillingMonth {
  month: string;
  debitCents: number;
  creditCents: number;
  netCents: number;
  count: number;
}

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

export interface BillingTransaction {
  id: string;
  kind: TransactionKind;
  direction: 'debit' | 'credit';
  amountCents: number;
  taxCents: number;
  currency: string;
  status: TransactionStatus;
  occurredAt: string;
  description: string;
  receiptUrl: string | null;
  reservationId: string | null;
}

export interface SetupIntentResult {
  clientSecret: string;
  customerId: string;
  ephemeralKeySecret: string;
}

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

export type StepUpMethod = 'password' | 'oauth' | 'reauth_email';

export type DeleteAccountProof =
  | { password: string }
  | { provider: 'google' | 'apple'; idToken: string; nonce: string }
  | { reauthToken: string };

export interface DeleteAccountResult {
  status: 'completed' | 'in_progress' | 'failed';
}

/**
 * Legacy member-portal booking shape (GET /api/me/home's `upcomingBookings`
 * and /api/me/bookings). Retained for the BookingCard component; the new
 * engine uses `Reservation`.
 */
export interface UpcomingBooking {
  id: string;
  facilityType: 'court' | 'shower';
  facilityId: string;
  facilityName: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
}

// ── Asset URL resolution (RN needs absolute URLs for images) ──

export function resolveApiAssetUrl(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(imageUrl) || imageUrl.startsWith('data:')) return imageUrl;
  try {
    return new URL(imageUrl, API_URL).toString();
  } catch {
    const baseUrl = API_URL.replace(/\/+$/, '');
    return `${baseUrl}/${imageUrl.replace(/^\/+/, '')}`;
  }
}

// ── Auth bridge (token access + refresh persistence, injected by session) ──

/**
 * How the request pipeline reads the current bearer token and reacts to a
 * refresh. The SessionProvider installs a bridge backed by React state +
 * SecureStore; tests install a fake. The default bridge holds an in-memory
 * access token so pre-session bootstrap works.
 */
export interface AuthBridge {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  /** A refresh succeeded: persist the new pair and update in-memory token. */
  onTokensRefreshed(tokens: SessionTokens): void;
  /** Refresh failed (or no refresh token): the session is dead, sign out. */
  onSessionInvalid(): void;
}

let inMemoryAccessToken: string | null = null;

const defaultBridge: AuthBridge = {
  getAccessToken: () => inMemoryAccessToken,
  getRefreshToken: () => null,
  onTokensRefreshed: (tokens) => {
    inMemoryAccessToken = tokens.accessToken;
  },
  onSessionInvalid: () => {
    inMemoryAccessToken = null;
  },
};

let authBridge: AuthBridge = defaultBridge;

export function setAuthBridge(bridge: AuthBridge | null) {
  authBridge = bridge ?? defaultBridge;
}

/** Set the in-memory access token used by the default bridge (bootstrap). */
export function setApiToken(token: string | null) {
  inMemoryAccessToken = token;
}

// ── Request pipeline ──

function normalizeJsonResponse(text: string): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isAuthPath(path: string): boolean {
  return path.startsWith('/api/auth/');
}

async function performRequest(path: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers);
  const isFormDataBody = typeof FormData !== 'undefined' && options?.body instanceof FormData;

  if (!isFormDataBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const token = authBridge.getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  // The backend derives the token transport from this header.
  if (isAuthPath(path)) headers.set('X-Client-Type', 'mobile');

  return fetch(`${API_URL}${path}`, { ...options, headers });
}

/**
 * A refresh attempt has three outcomes the pipeline reacts to differently.
 * Collapsing `invalid` and `transient` into one "failed" bit is what forced a
 * full re-login on a momentary network blip or a 5xx from /refresh.
 *  - `refreshed`: new pair persisted via the bridge; retry the request.
 *  - `invalid`:   the refresh token is definitively dead (401/403, a malformed
 *                 2xx body, or no refresh token at all) -> sign out.
 *  - `transient`: network error, timeout, or 5xx -> KEEP the session and let
 *                 the caller retry; a blip must never clear credentials.
 */
type RefreshOutcome = 'refreshed' | 'invalid' | 'transient';

let refreshInFlight: Promise<RefreshOutcome> | null = null;

/** Single-flight refresh. Concurrent 401s share one refresh and one outcome. */
async function tryRefresh(): Promise<RefreshOutcome> {
  const refreshToken = authBridge.getRefreshToken();
  if (!refreshToken) return 'invalid';

  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Type': 'mobile' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        // Only an explicit auth rejection means the refresh token is dead.
        // 5xx / 429 / anything else is a transient server-side failure.
        return res.status === 401 || res.status === 403 ? 'invalid' : 'transient';
      }
      const json = normalizeJsonResponse(await res.text());
      const data = json.data as IssuedSession | undefined;
      if (!data?.accessToken || !data.refreshToken) return 'invalid';
      authBridge.onTokensRefreshed({
        accessToken: data.accessToken,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
        refreshToken: data.refreshToken,
        refreshTokenExpiresAt: data.refreshTokenExpiresAt,
      });
      return 'refreshed';
    } catch {
      // Thrown fetch = network error / timeout: the session may still be valid.
      return 'transient';
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Core request pipeline. Flow packages define endpoints on `api` below in
 * terms of this helper; avoid calling it ad hoc from components.
 */
export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let res = await performRequest(path, options);

  // Expired access token: refresh once and retry. Auth endpoints are
  // excluded; /me returns 200 with data:null when signed out, not 401.
  if (res.status === 401 && !isAuthPath(path)) {
    const outcome = await tryRefresh();
    if (outcome === 'refreshed') {
      res = await performRequest(path, options);
    } else if (outcome === 'invalid') {
      // Definitively dead: sign out, then surface the original 401 below.
      authBridge.onSessionInvalid();
    } else {
      // Transient: keep the session intact and let the caller retry. Never
      // clear credentials over a network blip or a 5xx from /refresh.
      throw new ApiError(
        'SESSION_REFRESH_UNAVAILABLE',
        'Could not refresh your session. Check your connection and try again.',
        503,
      );
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

  return json.data as T;
}

/** Raw refresh used by the SessionProvider during cold-start bootstrap. */
export async function refreshSessionTokens(refreshToken: string): Promise<IssuedSession> {
  return request<IssuedSession>('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  });
}

function normalizeSpotlight(event: SpotlightEvent): SpotlightEvent {
  return { ...event, imageUrl: resolveApiAssetUrl(event.imageUrl) };
}

export const api = {
  // ── Session ──
  getMe: () => request<Principal | null>('/api/auth/me'),
  signOut: () => request<{ signedOut: true }>('/api/auth/signout', { method: 'POST' }),

  // ── Password auth (bearer pair in the body for mobile) ──
  signUp: (input: SignUpInput) =>
    request<IssuedSession>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  signIn: (input: { email: string; password: string }) =>
    request<IssuedSession>('/api/auth/signin', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ── Native OAuth (Google / Apple ID-token + raw nonce) ──
  oauthNonce: () =>
    request<{ nonce: string; expiresAt: string }>('/api/auth/oauth/nonce', { method: 'POST' }),
  oauthGoogle: (input: { idToken: string; nonce: string }) =>
    request<IssuedSession>('/api/auth/oauth/google', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  oauthApple: (input: OAuthAppleInput) =>
    request<IssuedSession>('/api/auth/oauth/apple', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ── Magic link (native deep-link flow: redirectTo returns the token pair) ──
  sendMagicLink: (email: string, redirectTo: string) =>
    request<{ sent: true }>('/api/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email, redirectTo }),
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
    request<{ sent: true }>('/api/auth/email/resend', { method: 'POST', body: '{}' }),

  // ── Venue (public; the zone all date math anchors on) ──
  getVenue: () => request<VenueInfo>('/api/venue'),

  // ── Plans & membership ──
  getPlans: () => request<Plan[]>('/api/plans'),
  subscribeMembership: (input: { planId: string; termsVersion: string }) =>
    request<SubscribeMembershipResult>('/api/me/membership/subscribe', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  confirmMembership: () =>
    request<ConfirmMembershipResult>('/api/me/membership/confirm', {
      method: 'POST',
      body: '{}',
    }),
  changeMembership: (planId: string) =>
    request<ChangeMembershipResult>('/api/me/membership/change', {
      method: 'POST',
      body: JSON.stringify({ planId }),
    }),
  cancelMembership: (options: { now?: boolean } = {}) =>
    request<CancelMembershipResult>(`/api/me/membership${options.now ? '?now=true' : ''}`, {
      method: 'DELETE',
    }),

  // ── Billing ──
  getBilling: () => request<BillingOverview>('/api/me/billing'),
  getBillingTransactions: (month: string) =>
    request<{ month: string; transactions: BillingTransaction[] }>(
      `/api/me/billing/transactions?${new URLSearchParams({ month })}`,
    ),
  createSetupIntent: () =>
    request<SetupIntentResult>('/api/me/payment-methods/setup-intent', {
      method: 'POST',
      body: '{}',
    }),
  setDefaultPaymentMethod: (paymentMethodId: string) =>
    request<{ default: string }>(
      `/api/me/payment-methods/${encodeURIComponent(paymentMethodId)}/default`,
      { method: 'POST', body: '{}' },
    ),

  // ── Onboarding + id verification ──
  getOnboarding: () => request<OnboardingState>('/api/me/onboarding'),
  getIdVerification: () => request<IdVerificationView>('/api/me/id-verification'),
  /** Multipart photo upload; `photo` is an RN file part { uri, name, type }. */
  uploadIdPhoto: (photo: { uri: string; name: string; type: string }) => {
    const body = new FormData();
    body.append('photo', photo as unknown as Blob);
    return request<IdVerificationView>('/api/me/id-verification/photo', {
      method: 'POST',
      body,
    });
  },
  submitIdVerification: () =>
    request<IdVerificationView>('/api/me/id-verification/submit', { method: 'POST', body: '{}' }),
  skipIdVerification: () =>
    request<IdVerificationView>('/api/me/id-verification/skip', { method: 'POST', body: '{}' }),

  // ── Booking (M3; reads/mutations shared with M2 home + M4 detail) ──
  getResourceTypes: () => request<ResourceTypeSummary[]>('/api/resource-types'),
  getAvailability: (
    typeCode: string,
    params: { date: string; days?: number; excludeReservationId?: string },
  ) => {
    const query = new URLSearchParams({ date: params.date });
    if (params.days !== undefined) query.set('days', String(params.days));
    if (params.excludeReservationId) query.set('excludeReservationId', params.excludeReservationId);
    return request<AvailabilityDay[]>(
      `/api/resource-types/${encodeURIComponent(typeCode)}/availability?${query}`,
    );
  },
  quoteReservation: (input: { typeCode: string; date: string; slots: string[] }) =>
    request<ReservationQuote>('/api/reservations/quote', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
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
  confirmReservation: (id: string) =>
    request<Reservation>(`/api/reservations/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      body: '{}',
    }),
  reissuePaymentIntent: (id: string) =>
    request<ReissuePaymentIntentResult>(
      `/api/reservations/${encodeURIComponent(id)}/payment-intent`,
      { method: 'POST', body: '{}' },
    ),
  getReservation: (id: string) =>
    request<Reservation & { viewer: ReservationViewer }>(
      `/api/reservations/${encodeURIComponent(id)}`,
    ),
  cancelReservation: (id: string) =>
    request<{ cancelled: boolean; refundCents: number }>(
      `/api/reservations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  addParticipants: (id: string, invitees: ReservationInvitees) =>
    request<{ invited: string[] }>(`/api/reservations/${encodeURIComponent(id)}/participants`, {
      method: 'POST',
      body: JSON.stringify(invitees),
    }),
  removeParticipant: (id: string, memberId: string) =>
    request<{ removed: true }>(
      `/api/reservations/${encodeURIComponent(id)}/participants/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' },
    ),
  respondReservation: (id: string, response: 'accept' | 'decline') =>
    request<{ status: ReservationParticipantStatus }>(
      `/api/reservations/${encodeURIComponent(id)}/respond`,
      { method: 'POST', body: JSON.stringify({ response }) },
    ),
  rescheduleQuote: (id: string, change: { date: string; slots: string[] }) =>
    request<RescheduleQuote>(`/api/reservations/${encodeURIComponent(id)}/reschedule-quote`, {
      method: 'POST',
      body: JSON.stringify(change),
    }),
  rescheduleReservation: (id: string, change: { date: string; slots: string[] }) =>
    request<RescheduleResult>(`/api/reservations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(change),
    }),
  searchMembers: (q: string, limit = 10) => {
    const query = new URLSearchParams({ limit: String(limit) });
    const trimmed = q.trim();
    if (trimmed) query.set('q', trimmed);
    return request<MemberSearchResult[]>(`/api/members/search?${query}`);
  },

  // ── Home (M2) ──
  getHome: (tz?: string) =>
    request<HomeFeed>(`/api/me/home${tz ? `?${new URLSearchParams({ tz })}` : ''}`).then(
      (feed) => ({ ...feed, spotlightEvents: feed.spotlightEvents.map(normalizeSpotlight) }),
    ),
  getMemberQr: () => request<MemberQrToken>('/api/me/qr'),

  // ── Account: profile & avatar (M6) ──
  getProfile: () => request<MyProfile>('/api/me/profile'),
  updateProfile: (input: { displayName: string | null }) =>
    request<{ member: HomeMember }>('/api/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  uploadAvatar: (image: { uri: string; name: string; type: string }) => {
    const body = new FormData();
    body.append('image', image as unknown as Blob);
    return request<{ avatarUrl: string }>('/api/me/avatar', { method: 'POST', body });
  },

  // ── Account: notification preferences + push devices (M6) ──
  getPreferences: () => request<NotificationPreferences>('/api/me/preferences'),
  putPreferences: (changes: Partial<NotificationPreferences>) =>
    request<NotificationPreferences>('/api/me/preferences', {
      method: 'PUT',
      body: JSON.stringify(changes),
    }),
  registerDevice: (input: { token: string; platform: 'ios' | 'android' }) =>
    request<RegisteredDevice>('/api/me/devices', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  unregisterDevice: (token: string) =>
    request<{ removed: boolean }>(`/api/me/devices/${encodeURIComponent(token)}`, {
      method: 'DELETE',
    }),

  // ── Clubs (M5; M3 reads list + roster for invite chips) ──
  getMyClubs: () => request<MyClub[]>('/api/me/clubs'),
  getMyClubInvitations: () => request<ClubInvitation[]>('/api/me/club-invitations'),
  createClub: (input: { name: string; description?: string; inviteeMemberIds?: string[] }) =>
    request<{ club: ClubSummary; invited: string[] }>('/api/clubs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getClub: (clubId: string) => request<ClubDetail>(`/api/clubs/${encodeURIComponent(clubId)}`),
  updateClub: (
    clubId: string,
    input: { name?: string; description?: string | null; coverImageUrl?: null },
  ) =>
    request<ClubSummary>(`/api/clubs/${encodeURIComponent(clubId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteClub: (clubId: string) =>
    request<{ deleted: boolean }>(`/api/clubs/${encodeURIComponent(clubId)}`, { method: 'DELETE' }),
  uploadClubCover: (clubId: string, image: { uri: string; name: string; type: string }) => {
    const body = new FormData();
    body.append('image', image as unknown as Blob);
    return request<ClubSummary>(`/api/clubs/${encodeURIComponent(clubId)}/cover-image`, {
      method: 'POST',
      body,
    });
  },
  leaveClub: (clubId: string) =>
    request<{ left: boolean }>(`/api/clubs/${encodeURIComponent(clubId)}/leave`, {
      method: 'POST',
      body: '{}',
    }),
  getClubMembers: (clubId: string) =>
    request<ClubRosterEntry[]>(`/api/clubs/${encodeURIComponent(clubId)}/members`),
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
  inviteClubMembers: (clubId: string, memberIds: string[]) =>
    request<{ invited: string[] }>(`/api/clubs/${encodeURIComponent(clubId)}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ memberIds }),
    }),
  respondClubInvitation: (id: string, response: 'accept' | 'decline') =>
    request<{ status: string; clubId: string }>(
      `/api/club-invitations/${encodeURIComponent(id)}/respond`,
      { method: 'POST', body: JSON.stringify({ response }) },
    ),
  createClubInviteLink: (
    clubId: string,
    options: { expiresInDays?: number; maxUses?: number; rotate?: boolean } = {},
  ) =>
    request<ClubInviteLink>(`/api/clubs/${encodeURIComponent(clubId)}/invite-link`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  previewClubInvite: (token: string) =>
    request<ClubInvitePreview>('/api/clubs/invite-preview', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  joinClub: (token: string) =>
    request<ClubJoinResult>('/api/clubs/join', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  getClubActivity: (clubId: string, filter: 'upcoming' | 'past' | 'all' = 'all') =>
    request<ClubActivityItem[]>(
      `/api/clubs/${encodeURIComponent(clubId)}/activity?${new URLSearchParams({ filter })}`,
    ),

  // ── Account deletion + sign-in methods (M6) ──
  getAuthIdentities: () => request<AuthIdentities>('/api/me/auth-identities'),
  linkAuthIdentity: (
    provider: 'google' | 'apple',
    input: { idToken: string; nonce: string; authorizationCode?: string },
  ) =>
    request<{ provider: string; linked: boolean }>(
      `/api/me/auth-identities/${encodeURIComponent(provider)}`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  unlinkAuthIdentity: (provider: 'google' | 'apple') =>
    request<{ provider: string; unlinked: boolean }>(
      `/api/me/auth-identities/${encodeURIComponent(provider)}`,
      { method: 'DELETE' },
    ),
  requestReauthEmail: () =>
    request<{ sent: true }>('/api/me/reauth-email', { method: 'POST', body: '{}' }),
  deleteAccount: (proof: DeleteAccountProof) =>
    request<DeleteAccountResult>('/api/me', {
      method: 'DELETE',
      body: JSON.stringify(proof),
    }),
};
