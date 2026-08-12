import { createHash } from 'node:crypto';
import { db } from './db';
import { PrismaUnitOfWork } from './infrastructure/prisma-unit-of-work';
import { EventStore } from './infrastructure/event-store';
import { OutboxDispatcher, OutboxRepository } from './infrastructure/outbox';

// Repositories + infrastructure
import { IdVerificationRepository, MemberRepository } from '@/lib/contexts/members/infrastructure';
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
import {
  BookingReminderRepository,
  DeliveredNotificationRepository,
  DeviceRepository,
  ExpoPushAdapter,
  NotificationPreferenceRepository,
  ResendAdapter,
} from '@/lib/contexts/communications/infrastructure';
import {
  ResourceTypeRepository,
  ResourceRepository,
  ReservationRepository,
  ReservationSeriesRepository,
  SlotClaimRepository,
  PrismaMembershipChecker,
  StubBookingPaymentAdapter,
} from '@/lib/contexts/bookings/infrastructure';
import { ClubEventRepository } from '@/lib/contexts/events/infrastructure';
import { ClubRepository, ClubRosterAdapter } from '@/lib/contexts/clubs/infrastructure';
import { LocalMediaStorage, PrismaManagedMediaAssetRepository, S3MediaStorage, SharpImageProcessor } from '@/lib/contexts/media/infrastructure';

// Application services
import { IdVerificationService, MemberAvatarService, MemberQrService, MemberService } from '@/lib/contexts/members/application';
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
  StepUpService,
  AccountErasureService,
} from '@/lib/contexts/identity/application';
import { AccountDeletionService } from '@/lib/contexts/account/application';
import { DeletionRequestRepository } from '@/lib/contexts/account/infrastructure';
import {
  BookingReminderService,
  NotificationDispatchService,
  NotificationService,
  NotificationSettingsService,
} from '@/lib/contexts/communications/application';
import { ReservationService, ResourceClaimService, SeriesService } from '@/lib/contexts/bookings/application';
import { ClubEventService } from '@/lib/contexts/events/application';
import { ClubService } from '@/lib/contexts/clubs/application';
import { MediaService } from '@/lib/contexts/media/application';
import { HomeService } from '@/lib/contexts/home';
import { TierRequiredError, ResourceTypeNotFoundError } from '@/lib/contexts/bookings';

// ── Infrastructure singletons ──

export const uow = new PrismaUnitOfWork(db);
export const eventStore = new EventStore();

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
export const imageProcessor = new SharpImageProcessor();

// ── Communications ──

const resendAdapter = new ResendAdapter(process.env.RESEND_API_KEY ?? '');
export const notificationService = new NotificationService(resendAdapter);
export const notificationSettingsService = new NotificationSettingsService(
  new NotificationPreferenceRepository(db),
  new DeviceRepository(db),
);

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
// Avatars ride the media pipeline under their own public usage; the
// members context reaches it only through this usage-pinned adapter.
export const memberAvatarService = new MemberAvatarService(memberService, {
  uploadAvatar: async (input: { filename: string; contentType: string; bytes: Buffer }) => {
    const asset = await mediaService.upload('avatar', input);
    return { publicUrl: asset.publicUrl! };
  },
  attachToMember: (publicUrl: string, memberId: string) =>
    mediaService.attachAssetToOwner(publicUrl, { ownerType: 'member', ownerId: memberId }, { expectUsage: 'avatar' }),
  deleteAvatar: async (publicUrl: string | null | undefined) => {
    await mediaService.deleteAsset(publicUrl, { expectUsage: 'avatar' });
  },
});

// Government-ID photos ride the media pipeline's PRIVATE usage: encrypted
// at rest, never publicly served, fetched only through the audited staff
// endpoint, deleted after review and on account deletion.
export const idVerificationService = new IdVerificationService(
  new IdVerificationRepository(db),
  {
    uploadIdPhoto: async (input: { filename: string; contentType: string; bytes: Buffer }) => {
      const asset = await mediaService.upload('id-photo', input);
      return { storagePath: asset.storagePath };
    },
    attachToMember: (storagePath: string, memberId: string) =>
      mediaService.attachAssetToOwner(storagePath, { ownerType: 'member', ownerId: memberId }, { expectUsage: 'id-photo' }),
    deleteIdPhoto: async (storagePath: string | null | undefined) => {
      await mediaService.deleteAsset(storagePath, { expectUsage: 'id-photo' });
    },
    readIdPhoto: (storagePath: string) => mediaService.readPrivateAsset(storagePath, 'id-photo'),
  },
  eventStore,
  uow,
);

// The member QR credential signs with a dedicated key derivation (its own
// env var when set), never the raw JWT secret.
export const memberQrService = new MemberQrService(
  memberRepo,
  createHash('sha256')
    .update(`${process.env.MEMBER_QR_SECRET?.trim() || process.env.JWT_SECRET || 'dev-fallback-secret-not-for-production'}:member-qr`)
    .digest(),
);

// Clubs BC: bookings expands club-chip invites ONLY through this port.
export const clubRepo = new ClubRepository(db);
export const clubRosterPort = new ClubRosterAdapter(db);

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
  clubRosterPort,
);
export const resourceClaimPort = new ResourceClaimService(
  resourceRepo,
  slotClaimRepo,
  reservationService,
  VENUE_TIMEZONE,
);

// Weekly series (OPEN decision 8): admin-only creation; the materialize
// cron books comp occurrences inside the horizon, skipping + notifying on
// collision (never silently shifting).
export const seriesService = new SeriesService(
  new ReservationSeriesRepository(db),
  resourceTypeRepo,
  reservationRepo,
  reservationService,
  eventStore,
  uow,
  VENUE_TIMEZONE,
);
// Private assets (ID photos) are encrypted at rest under a media-specific
// key. MEDIA_ENCRYPTION_KEY is required in production so rotating
// JWT_SECRET (a routine security action) can never brick stored photos;
// keyless local dev derives from the JWT secret.
const mediaEncryptionKey = process.env.MEDIA_ENCRYPTION_KEY?.trim();
if (!mediaEncryptionKey && process.env.NODE_ENV === 'production') {
  throw new Error('MEDIA_ENCRYPTION_KEY must be set in production');
}

export const mediaService = new MediaService(
  mediaStorage,
  managedMediaAssetRepo,
  imageProcessor,
  new AesGcmCipher(mediaEncryptionKey || (process.env.JWT_SECRET ?? 'dev-fallback-secret-not-for-production'), 'media-at-rest'),
);

// Consumer BCs reach media through narrow usage-pinned adapters: a call
// wired for event images can never attach or delete an asset of another
// usage (someone's ID photo) by being handed its path.
const eventImageStore = {
  deleteManagedAsset: async (path: string | null | undefined) => {
    await mediaService.deleteAsset(path, { expectUsage: 'event-image' });
  },
  isManagedAsset: (path: string | null | undefined) => mediaService.isManagedAsset(path),
  attachManagedAssetToOwner: (path: string | null | undefined, owner: { ownerType: string; ownerId: string }) =>
    mediaService.attachAssetToOwner(path, owner, { expectUsage: 'event-image' }),
};
// Club covers deliberately share the event-image usage (same directory,
// sizing and lifecycle as before the pipeline was generalized).
const clubCoverStore = {
  uploadCoverImage: async (input: { filename: string; contentType: string; bytes: Buffer }) => {
    const asset = await mediaService.upload('event-image', input);
    return { publicPath: asset.storagePath };
  },
  ...eventImageStore,
};

export const clubEventService = new ClubEventService(clubEventRepo, resourceClaimPort, eventImageStore, uow);
export const clubService = new ClubService(clubRepo, clubCoverStore, eventStore, uow);

// ── Notification delivery (package F) ──
// The outbox consumer: pure decision matrix in the communications domain,
// recipients resolved through the narrow read adapters below (public
// barrel classes only), sends guarded by the delivered-notifications
// ledger. Push degrades to a console log without EXPO_PUSH_ACCESS_TOKEN,
// exactly as Resend does without RESEND_API_KEY.
const pushSender = new ExpoPushAdapter(process.env.EXPO_PUSH_ACCESS_TOKEN?.trim() ?? '');

// Shared read adapters for the dispatcher and the reminder cron.
const recipientDirectory = {
  getContact: async (memberId: string) => {
    const member = await memberRepo.getById(memberId);
    return member && !member.deletedAt
      ? { memberId: member.id, email: member.email, firstName: member.firstName }
      : null;
  },
};
const toReservationNotificationView = (detail: NonNullable<Awaited<ReturnType<typeof reservationRepo.getDetail>>>) => ({
  id: detail.id,
  reference: detail.reference,
  typeName: detail.resourceType.name,
  resourceName: detail.resource.name,
  localDate: detail.localDate,
  startsAt: detail.startsAt,
  endsAt: detail.endsAt,
  organizerId: detail.organizerId,
  seriesId: detail.seriesId,
  status: detail.status,
  participants: detail.participants.map((participant) => ({
    memberId: participant.memberId,
    role: participant.role,
    status: participant.status,
  })),
});

export const notificationDispatchService = new NotificationDispatchService(
  new DeliveredNotificationRepository(db),
  new NotificationPreferenceRepository(db),
  new DeviceRepository(db),
  resendAdapter,
  pushSender,
  recipientDirectory,
  {
    getNotificationView: async (reservationId: string) => {
      const detail = await reservationRepo.getDetail(reservationId);
      return detail ? toReservationNotificationView(detail) : null;
    },
  },
  {
    getClubName: async (clubId: string) => (await clubRepo.getClub(clubId))?.name ?? null,
    getInvitationView: async (invitationId: string) => {
      const invitation = await clubRepo.getInvitation(invitationId);
      if (!invitation) return null;
      const club = await clubRepo.getClub(invitation.clubId);
      return {
        invitationId: invitation.id,
        clubId: invitation.clubId,
        clubName: club?.name ?? 'your club',
        inviterMemberId: invitation.inviterId ?? null,
        inviteeMemberId: invitation.inviteeMemberId,
      };
    },
  },
  {
    timezone: VENUE_TIMEZONE,
    staffAlertEmail: process.env.STAFF_ALERT_EMAIL?.trim() || null,
  },
);

// Audit log doubles as the transactional outbox; the dispatcher hands
// undispatched rows to the notification consumer and marks only the
// delivered ones dispatched (failed ones stay pending and retry).
export const outboxDispatcher = new OutboxDispatcher(uow, new OutboxRepository(), notificationDispatchService);

// ── Home read context (package F) ──
// Pure composition: the home screen's facts come from the other contexts
// through these narrow port adapters (public services/barrels only), always
// keyed by the caller's own member id.
export const homeService = new HomeService(
  {
    getProfile: async (memberId: string) => {
      const member = await memberRepo.getById(memberId);
      return member && !member.deletedAt
        ? { id: member.id, firstName: member.firstName, displayName: member.displayName ?? null }
        : null;
    },
  },
  {
    hasActiveMembership: (memberId: string) => membershipChecker.hasActiveMembership(memberId),
    listUpcomingForMember: (memberId: string) => reservationService.listForMember(memberId, 'upcoming'),
    listRecentConfirmedHistory: (memberId: string) => reservationService.listRecentConfirmedHistory(memberId),
    listAmenitiesForMember: async (memberId: string) =>
      (await reservationService.listResourceTypesForMember(memberId)).map((type) => ({
        code: type.code,
        name: type.name,
        hourlyRateCents: type.hourlyRateCents,
        locked: type.locked,
        resourceCount: type.resourceCount,
        slotDurationMinutes: type.slotDurationMinutes,
        maxAdvanceDays: type.maxAdvanceDays,
      })),
    listAvailableStarts: async (memberId: string, typeCode: string, date: string) => {
      try {
        const [day] = await reservationService.getAvailability({ typeCode, startDate: date, days: 1, memberId });
        return day?.slots.map((slot) => slot.start) ?? [];
      } catch (error) {
        // A tier-locked or retired type simply has nothing to offer here.
        if (error instanceof TierRequiredError || error instanceof ResourceTypeNotFoundError) return [];
        throw error;
      }
    },
    fitsSingleResource: async (memberId: string, typeCode: string, date: string, slots: string[]) => {
      try {
        await reservationService.quote({ typeCode, date, slots, memberId });
        return true;
      } catch {
        return false;
      }
    },
  },
  { listPendingInvitations: (memberId: string) => clubService.listMyInvitations(memberId) },
  { listUpcoming: () => clubEventService.list({ includeInactive: false, includePast: false }) },
  VENUE_TIMEZONE,
);

// Booking reminders (cron, hourly): confirmed reservations starting within
// the next 24h, one reminder per (reservation, member) ever, channels per
// the member's bookingReminders/push/email toggles.
export const bookingReminderService = new BookingReminderService(
  {
    listConfirmedStartingBetween: async (from: Date, to: Date) =>
      (await reservationService.listConfirmedStartingBetween(from, to)).map(toReservationNotificationView),
  },
  new BookingReminderRepository(db),
  new NotificationPreferenceRepository(db),
  new DeviceRepository(db),
  resendAdapter,
  pushSender,
  recipientDirectory,
  { timezone: VENUE_TIMEZONE },
);

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
  eventStore,
  uow,
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
// Accepted Apple `aud` values: the native bundle ID (Sign in with Apple on
// device) and the web services ID (Sign in with Apple JS). Either alone works;
// with neither set the verifier throws NOT_CONFIGURED when used.
const appleVerifier = new AppleIdTokenVerifier(
  [process.env.APPLE_BUNDLE_ID, process.env.APPLE_WEB_SERVICES_ID]
    .map((aud) => aud?.trim() ?? '')
    .filter(Boolean),
);
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

// Step-up re-auth for destructive actions (account deletion).
export const stepUpService = new StepUpService(
  credentialRepo,
  authIdentityRepo,
  authTokenRepo,
  passwordHasher,
  { google: googleVerifier, apple: appleVerifier },
  notificationService,
);

// The identity side of account deletion (quiesce, Apple revoke, credential
// erasure, user tombstone), consumed by the account context's saga.
export const accountErasureService = new AccountErasureService(
  userRepo,
  credentialRepo,
  authIdentityRepo,
  authTokenRepo,
  sessionService,
  appleGateway,
  secretCipher,
  eventStore,
  uow,
);

// ── Account BC (the deletion saga; constructed last, it consumes every
// other context through its ports) ──

export const accountDeletionService = new AccountDeletionService(
  new DeletionRequestRepository(db),
  billingService,
  reservationService,
  clubService,
  accountErasureService,
  {
    getMemberNumber: async (memberId: string) => {
      const member = await memberRepo.getById(memberId);
      return member?.memberNumber ?? null;
    },
    scrubMember: async (memberId: string) => {
      const { previousAvatarUrl } = await memberService.scrubForAccountDeletion(memberId);
      await mediaService.deleteAsset(previousAvatarUrl, { expectUsage: 'avatar' });
    },
    purgeIdVerification: (memberId: string) => idVerificationService.purgeForMember(memberId),
  },
  notificationSettingsService,
  eventStore,
  uow,
);
