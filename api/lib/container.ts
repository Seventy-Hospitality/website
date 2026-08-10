import { db } from './db';
import { PrismaUnitOfWork } from './infrastructure/prisma-unit-of-work';
import { EventStore } from './infrastructure/event-store';
import { EventReplay } from './infrastructure/event-replay';

// Repositories + infrastructure
import { MemberRepository } from '@/lib/contexts/members/infrastructure';
import { MembershipRepository, PlanRepository, StripeGateway } from '@/lib/contexts/memberships/infrastructure';
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
import { CourtRepository, ShowerRepository, BookingRepository, PrismaMembershipChecker } from '@/lib/contexts/bookings/infrastructure';
import { ClubEventRepository } from '@/lib/contexts/events/infrastructure';
import { LocalMediaStorage, PrismaManagedMediaAssetRepository, S3MediaStorage, SharpEventImageProcessor } from '@/lib/contexts/media/infrastructure';

// Application services
import { MemberService } from '@/lib/contexts/members/application';
import { MembershipService } from '@/lib/contexts/memberships/application';
import {
  AuthenticationService,
  SessionService,
  AccountLinkingService,
  MemberClaimService,
} from '@/lib/contexts/identity/application';
import { NotificationService } from '@/lib/contexts/communications/application';
import { BookingService } from '@/lib/contexts/bookings/application';
import { ClubEventService } from '@/lib/contexts/events/application';
import { MediaService } from '@/lib/contexts/media/application';

// ── Infrastructure singletons ──

export const uow = new PrismaUnitOfWork(db);
export const eventStore = new EventStore();
export const eventReplay = new EventReplay(db);

// ── Repositories ──

export const memberRepo = new MemberRepository(db);
export const membershipRepo = new MembershipRepository(db);
export const planRepo = new PlanRepository(db);
export const stripeGateway = new StripeGateway(
  process.env.STRIPE_SECRET_KEY ?? '',
  process.env.WEB_URL ?? 'http://localhost:5173',
);

// ── Bookings BC ──

export const courtRepo = new CourtRepository(db);
export const showerRepo = new ShowerRepository(db);
export const bookingRepo = new BookingRepository(db);
export const membershipChecker = new PrismaMembershipChecker(db);
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
export const membershipService = new MembershipService(membershipRepo, planRepo, stripeGateway);
export const bookingService = new BookingService(courtRepo, showerRepo, bookingRepo, membershipChecker, clubEventRepo, uow);
export const mediaService = new MediaService(mediaStorage, managedMediaAssetRepo, eventImageProcessor);
export const clubEventService = new ClubEventService(clubEventRepo, bookingRepo, courtRepo, mediaService);

// ── Identity ──

export const userRepo = new UserRepository(db);
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
