import { db } from './db';
import { PrismaUnitOfWork } from './infrastructure/prisma-unit-of-work';
import { EventStore } from './infrastructure/event-store';
import { EventReplay } from './infrastructure/event-replay';

// Repositories + infrastructure
import { MemberRepository } from '@/lib/contexts/members/infrastructure';
import { MembershipRepository, PlanRepository, StripeGateway } from '@/lib/contexts/memberships/infrastructure';
import { SessionRepository, MagicLinkRepository, JwtService, UserRepository } from '@/lib/contexts/auth/infrastructure';
import { ResendAdapter } from '@/lib/contexts/communications/infrastructure';
import { CourtRepository, ShowerRepository, BookingRepository, PrismaMembershipChecker } from '@/lib/contexts/bookings/infrastructure';
import { ClubEventRepository } from '@/lib/contexts/events/infrastructure';
import { LocalMediaStorage, PrismaManagedMediaAssetRepository, S3MediaStorage, SharpEventImageProcessor } from '@/lib/contexts/media/infrastructure';

// Application services
import { MemberService } from '@/lib/contexts/members/application';
import { MembershipService } from '@/lib/contexts/memberships/application';
import { AuthService } from '@/lib/contexts/auth/application';
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

// ── Auth ──

const sessionRepo = new SessionRepository(db);
const magicLinkRepo = new MagicLinkRepository(db);
export const userRepo = new UserRepository(db);
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}
const jwtService = new JwtService(process.env.JWT_SECRET ?? 'dev-fallback-secret-not-for-production');

export const authService = new AuthService(
  sessionRepo,
  magicLinkRepo,
  userRepo,
  jwtService,
  notificationService,
  process.env.PUBLIC_BASE_URL ?? process.env.WEB_URL ?? process.env.API_URL ?? 'http://localhost:5173',
  process.env.WEB_URL ?? 'http://localhost:5173',
);
