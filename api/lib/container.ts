import { db } from './db';
import { PrismaUnitOfWork } from './infrastructure/prisma-unit-of-work';
import { EventStore } from './infrastructure/event-store';
import { NoopOutboxSink, OutboxDispatcher, OutboxRepository } from './infrastructure/outbox';

// Repositories + infrastructure
import { MemberRepository } from '@/lib/contexts/members/infrastructure';
import { MembershipRepository, PlanRepository } from '@/lib/contexts/memberships/infrastructure';
import {
  StripeGateway,
  TransactionRepository,
  PaymentMethodRepository,
  WebhookEventRepository,
  StripeBookingPaymentAdapter,
} from '@/lib/contexts/billing/infrastructure';
import {
  UserRepository,
  CredentialRepository,
  AuthIdentityRepository,
  AuthSessionRepository,
  AuthTokenRepository,
  JwtService,
  Argon2Hasher,
  AesGcmCipher,
  GoogleIdTokenVerifier,
  AppleIdTokenVerifier,
  AppleTokenGateway,
  PrismaMemberDirectory,
} from '@/lib/contexts/identity/infrastructure';
import { ResendAdapter } from '@/lib/contexts/communications/infrastructure';
import {
  ResourceTypeRepository,
  ResourceRepository,
  ReservationRepository,
  SlotClaimRepository,
  PrismaMembershipChecker,
  StubBookingPaymentAdapter,
} from '@/lib/contexts/bookings/infrastructure';
import { ClubEventRepository } from '@/lib/contexts/events/infrastructure';
import { LocalMediaStorage, PrismaManagedMediaAssetRepository, S3MediaStorage, SharpEventImageProcessor } from '@/lib/contexts/media/infrastructure';

// Application services
import { MemberService } from '@/lib/contexts/members/application';
import { MembershipService } from '@/lib/contexts/memberships/application';
import {
  BillingService,
  PaymentService,
  ReconciliationService,
  WebhookService,
} from '@/lib/contexts/billing/application';
import type { BookingPaymentPort } from '@/lib/contexts/bookings/domain';
import {
  AuthenticationService,
  SessionService,
  AccountLinkingService,
  MemberClaimService,
} from '@/lib/contexts/identity/application';
import { NotificationService } from '@/lib/contexts/communications/application';
import { ReservationService, ResourceClaimService } from '@/lib/contexts/bookings/application';
import { ClubEventService } from '@/lib/contexts/events/application';
import { MediaService } from '@/lib/contexts/media/application';

// ── Infrastructure singletons ──

export const uow = new PrismaUnitOfWork(db);
export const eventStore = new EventStore();

// Audit log doubles as the transactional outbox; the dispatcher marks rows
// dispatched, and the sink is package F's seam (nothing is sent yet).
export const outboxDispatcher = new OutboxDispatcher(uow, new OutboxRepository(), new NoopOutboxSink());

// ── Venue ──
// One venue, one wall clock: every reservation slot lives in this zone.
export const VENUE_TIMEZONE = process.env.VENUE_TIMEZONE?.trim() || 'America/New_York';

// ── Repositories ──

export const memberRepo = new MemberRepository(db);
export const membershipRepo = new MembershipRepository(db);
export const planRepo = new PlanRepository(db);
export const userRepo = new UserRepository(db);

// ── Billing BC ──
// Billing owns the Stripe gateway; memberships reaches Stripe only through
// its SubscriptionGateway port (the gateway implements it), bookings only
// through BookingPaymentPort (the adapter below).

export const stripeGateway = new StripeGateway(
  process.env.STRIPE_SECRET_KEY ?? '',
  process.env.WEB_URL ?? 'http://localhost:5173',
);
export const transactionRepo = new TransactionRepository(db);
export const paymentMethodRepo = new PaymentMethodRepository(db);
export const webhookEventRepo = new WebhookEventRepository(db);

// ── Scheduling BC ──

export const resourceTypeRepo = new ResourceTypeRepository(db);
export const resourceRepo = new ResourceRepository(db);
export const slotClaimRepo = new SlotClaimRepository(db);
export const reservationRepo = new ReservationRepository(db);
export const membershipChecker = new PrismaMembershipChecker(db);

// The real on-session PaymentIntent adapter needs a Stripe key. Keyless
// LOCAL development falls back to the instant-success stub; production
// never does (a missing key must fail payments closed, not book for free).
const stripeKeyConfigured = Boolean(process.env.STRIPE_SECRET_KEY?.trim());
if (!stripeKeyConfigured && process.env.NODE_ENV !== 'production') {
  console.warn('[billing] STRIPE_SECRET_KEY not set; booking payments use the dev stub adapter');
}
export const bookingPaymentPort: BookingPaymentPort =
  stripeKeyConfigured || process.env.NODE_ENV === 'production'
    ? new StripeBookingPaymentAdapter(stripeGateway, memberRepo, transactionRepo)
    : new StubBookingPaymentAdapter();

export const clubEventRepo = new ClubEventRepository(db);
export const managedMediaAssetRepo = new PrismaManagedMediaAssetRepository(db);

function createMediaStorage() {
  const backend = (process.env.MEDIA_BACKEND ?? 'local').trim().toLowerCase();

  if (backend === 's3') {
    const bucket = process.env.MEDIA_S3_BUCKET?.trim();
    if (!bucket) {
      throw new Error('MEDIA_S3_BUCKET is required when MEDIA_BACKEND=s3');
    }

    const region = process.env.MEDIA_S3_REGION?.trim() || process.env.AWS_REGION?.trim() || 'us-east-1';
    return new S3MediaStorage({
      bucket,
      region,
      prefix: process.env.MEDIA_S3_PREFIX?.trim(),
    });
  }

  if (backend === 'local') {
    return new LocalMediaStorage();
  }

  throw new Error(`Unsupported MEDIA_BACKEND: ${backend}`);
}

export const mediaStorage = createMediaStorage();
export const eventImageProcessor = new SharpEventImageProcessor();

// ── Communications ──

const resendAdapter = new ResendAdapter(process.env.RESEND_API_KEY ?? '');
export const notificationService = new NotificationService(resendAdapter);

// ── Application Services ──

export const memberService = new MemberService(memberRepo);
export const membershipService = new MembershipService(
  membershipRepo,
  planRepo,
  stripeGateway,
  // Terms acceptance lands on the user row (identity owns it).
  { recordAcceptance: (userId, version, when) => userRepo.recordTermsAcceptance(userId, version, when) },
  memberRepo,
);
export const reservationService = new ReservationService(
  resourceTypeRepo,
  resourceRepo,
  slotClaimRepo,
  reservationRepo,
  membershipChecker,
  bookingPaymentPort,
  eventStore,
  uow,
  { timezone: VENUE_TIMEZONE },
);
export const resourceClaimPort = new ResourceClaimService(
  resourceRepo,
  slotClaimRepo,
  reservationService,
  VENUE_TIMEZONE,
);
export const mediaService = new MediaService(mediaStorage, managedMediaAssetRepo, eventImageProcessor);
export const clubEventService = new ClubEventService(clubEventRepo, resourceClaimPort, mediaService, uow);

// ── Billing services ──
// Wired after the reservation service: billing drives bookings settlement
// (webhook + reconcile) through the BookingSettlementPort shape it exposes.

export const webhookService = new WebhookService(
  stripeGateway,
  webhookEventRepo,
  transactionRepo,
  paymentMethodRepo,
  membershipService,
  membershipRepo,
  reservationService,
  memberRepo,
);
export const billingService = new BillingService(
  transactionRepo,
  paymentMethodRepo,
  stripeGateway,
  memberRepo,
  membershipRepo,
  reservationService,
  VENUE_TIMEZONE,
);
export const paymentService = new PaymentService(stripeGateway, paymentMethodRepo, memberRepo, membershipRepo);
export const reconciliationService = new ReconciliationService(
  stripeGateway,
  transactionRepo,
  webhookEventRepo,
  memberRepo,
  membershipRepo,
  reservationService,
);

// ── Identity ──

const credentialRepo = new CredentialRepository(db);
const authIdentityRepo = new AuthIdentityRepository(db);
const authSessionRepo = new AuthSessionRepository(db);
const authTokenRepo = new AuthTokenRepository(db);
const memberDirectory = new PrismaMemberDirectory(db);

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}
const jwtSecret = process.env.JWT_SECRET ?? 'dev-fallback-secret-not-for-production';
const jwtService = new JwtService(jwtSecret);
const passwordHasher = new Argon2Hasher();
const secretCipher = new AesGcmCipher(jwtSecret);

// Verifiers boot without config and throw a clear error only when used.
const googleVerifier = new GoogleIdTokenVerifier(
  (process.env.GOOGLE_OAUTH_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);
const appleVerifier = new AppleIdTokenVerifier(process.env.APPLE_BUNDLE_ID?.trim() || undefined);
const appleGateway = new AppleTokenGateway({
  teamId: process.env.APPLE_TEAM_ID?.trim() || undefined,
  keyId: process.env.APPLE_KEY_ID?.trim() || undefined,
  privateKey: process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n') || undefined,
  bundleId: process.env.APPLE_BUNDLE_ID?.trim() || undefined,
});

const memberClaimService = new MemberClaimService(memberDirectory, eventStore);

export const sessionService = new SessionService(authSessionRepo, userRepo, jwtService, eventStore, uow);

export const authenticationService = new AuthenticationService(
  userRepo,
  credentialRepo,
  authTokenRepo,
  passwordHasher,
  sessionService,
  memberClaimService,
  notificationService,
  eventStore,
  uow,
  process.env.PUBLIC_BASE_URL ?? process.env.WEB_URL ?? process.env.API_URL ?? 'http://localhost:5173',
  process.env.WEB_URL ?? 'http://localhost:5173',
);

export const accountLinkingService = new AccountLinkingService(
  userRepo,
  authIdentityRepo,
  credentialRepo,
  authTokenRepo,
  { google: googleVerifier, apple: appleVerifier },
  appleGateway,
  secretCipher,
  memberClaimService,
  sessionService,
  eventStore,
  uow,
);
