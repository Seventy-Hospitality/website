import { db } from './db';
import { PrismaUnitOfWork } from './infrastructure/prisma-unit-of-work';
import { EventStore } from './infrastructure/event-store';
import { EventReplay } from './infrastructure/event-replay';

// Repositories + infrastructure
import { MemberRepository } from '@/lib/contexts/members/infrastructure';
import { MembershipRepository, PlanRepository, StripeGateway } from '@/lib/contexts/memberships/infrastructure';
import { SessionRepository, MagicLinkRepository, JwtService } from '@/lib/contexts/auth/infrastructure';
import { EmailAdapter } from '@/lib/contexts/communications/infrastructure';
import { CourtRepository, ShowerRepository, BookingRepository, PrismaMembershipChecker } from '@/lib/contexts/bookings/infrastructure';

// Application services
import { MemberService } from '@/lib/contexts/members/application';
import { MembershipService } from '@/lib/contexts/memberships/application';
import { AuthService } from '@/lib/contexts/auth/application';
import { NotificationService } from '@/lib/contexts/communications/application';
import { BookingService } from '@/lib/contexts/bookings/application';

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

// ── Communications ──

const emailAdapter = new EmailAdapter(process.env.RESEND_API_KEY ?? '');
export const notificationService = new NotificationService(emailAdapter);

// ── Application Services ──

export const memberService = new MemberService(memberRepo);
export const membershipService = new MembershipService(membershipRepo, planRepo, stripeGateway);
export const bookingService = new BookingService(courtRepo, showerRepo, bookingRepo, membershipChecker, uow);

// ── Auth ──

const sessionRepo = new SessionRepository(db);
const magicLinkRepo = new MagicLinkRepository(db);
const jwtService = new JwtService(process.env.JWT_SECRET ?? 'dev-fallback-secret-not-for-production');

export const authService = new AuthService(
  sessionRepo,
  magicLinkRepo,
  jwtService,
  notificationService,
  process.env.WEB_URL ?? 'http://localhost:5173',
);
