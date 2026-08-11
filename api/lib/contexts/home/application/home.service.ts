import {
  addDaysToDateKey,
  minutesToTimeLabel,
  timeLabelToMinutes,
  wallTimeToUtc,
  weekdayOfDateKey,
  zonedDateKey,
} from '@/lib/kernel';
import { MemberNotFoundError } from '@/lib/contexts/members';
import type { ReservationDetailRecord } from '@/lib/contexts/bookings';
import type { PendingInvitationItem } from '@/lib/contexts/clubs';
import type { ClubEvent } from '@/lib/contexts/events';
import {
  canonicalTimeZone,
  deriveQuickBookPattern,
  timeOfDayFor,
  WEEKDAY_NAMES,
  type QuickBookPattern,
  type TimeOfDay,
} from '../domain';
import type {
  HomeAmenity,
  HomeBookingsPort,
  HomeClubsPort,
  HomeEventsPort,
  HomeMembersPort,
} from './ports';

export interface HomeGreeting {
  firstName: string;
  timeOfDay: TimeOfDay;
  /** The zone the greeting was computed in (client tz when valid). */
  timezone: string;
}

export interface QuickBookSuggestion {
  typeCode: string;
  typeName: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  hourlyRateCents: number;
  /** Why this slot: the deterministic habit (or availability) explanation. */
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

export interface HomeView {
  greeting: HomeGreeting;
  /** Upcoming where the viewer is organizer or an accepted guest. */
  upcomingReservations: ReservationDetailRecord[];
  /** Upcoming where the viewer's participation is still pending: rendered
   *  distinctly with inline Accept/Decline. */
  pendingInvitations: ReservationDetailRecord[];
  clubInvitations: PendingInvitationItem[];
  spotlightEvents: ClubEvent[];
  quickBook: QuickBookSuggestion | null;
  /** Bookable amenity summary, present ONLY in the empty state. */
  emptyStateAmenities: HomeAmenitySummary[] | null;
}

/** How many candidate dates / starts the quick-book search will try. */
const QUICK_BOOK_DATE_TRIES = 2;
const QUICK_BOOK_FIT_TRIES = 5;

/**
 * The home-screen read composition. Home owns NO data: every fact comes
 * through a port over another context's public surface, always keyed by
 * the caller's own member id (IDOR-safe by construction). Recorded in
 * docs/decisions-notifications.md: why this lives in its own small read
 * context, and the exact quick-book heuristic.
 */
export class HomeService {
  constructor(
    private readonly members: HomeMembersPort,
    private readonly bookings: HomeBookingsPort,
    private readonly clubs: HomeClubsPort,
    private readonly events: HomeEventsPort,
    private readonly venueTimezone: string,
  ) {}

  async getHome(
    memberId: string,
    options: { timezone?: string | null; now?: Date } = {},
  ): Promise<HomeView> {
    const now = options.now ?? new Date();

    const [profile, upcoming, clubInvitations, spotlightEvents, rawAmenities, canBook] = await Promise.all([
      this.members.getProfile(memberId),
      this.bookings.listUpcomingForMember(memberId),
      this.clubs.listPendingInvitations(memberId),
      this.events.listUpcoming(),
      this.bookings.listAmenitiesForMember(memberId),
      this.bookings.hasActiveMembership(memberId),
    ]);
    if (!profile) throw new MemberNotFoundError(memberId);

    // Amenity `locked` is tier-only; a lapsed membership makes EVERYTHING
    // unbookable, so quick-book and the empty-state summary treat every
    // amenity as locked rather than suggesting slots that POST
    // /api/reservations would reject with InactiveMembershipError.
    const amenities = canBook ? rawAmenities : rawAmenities.map((amenity) => ({ ...amenity, locked: true }));

    const greetingTimezone = canonicalTimeZone(options.timezone) ?? this.venueTimezone;

    const statusOf = (reservation: ReservationDetailRecord) =>
      reservation.participants.find((participant) => participant.memberId === memberId)?.status;
    const pendingInvitations = upcoming.filter((reservation) => statusOf(reservation) === 'pending');
    const upcomingReservations = upcoming.filter((reservation) => statusOf(reservation) === 'confirmed');

    const emptyState = upcomingReservations.length === 0 && pendingInvitations.length === 0;
    const [quickBook, emptyStateAmenities] = await Promise.all([
      this.computeQuickBook(memberId, amenities, now),
      emptyState ? this.amenitySummary(memberId, amenities, now) : Promise.resolve(null),
    ]);

    return {
      greeting: {
        firstName: profile.firstName,
        timeOfDay: timeOfDayFor(now, greetingTimezone),
        timezone: greetingTimezone,
      },
      upcomingReservations,
      pendingInvitations,
      clubInvitations,
      spotlightEvents,
      quickBook,
      emptyStateAmenities,
    };
  }

  // ── Quick-book (deterministic heuristic; no ML) ──

  private async computeQuickBook(
    memberId: string,
    amenities: HomeAmenity[],
    now: Date,
  ): Promise<QuickBookSuggestion | null> {
    const history = await this.bookings.listRecentConfirmedHistory(memberId);
    const pattern = deriveQuickBookPattern(history);

    if (pattern) {
      const amenity = amenities.find((candidate) => candidate.code === pattern.typeCode);
      // A habit for an amenity the member can no longer book (tier lapse,
      // retired type) falls through to the availability fallback.
      if (amenity && !amenity.locked && amenity.resourceCount > 0) {
        for (const date of this.nextDatesForWeekday(pattern, amenity.maxAdvanceDays, now)) {
          const suggestion = await this.firstFittingSlot(memberId, amenity, date, {
            preferredStartMinutes: pattern.startMinutes,
            durationMinutes: pattern.durationMinutes,
            reason: `You often book ${amenity.name} on ${WEEKDAY_NAMES[pattern.weekday]}s around ${minutesToTimeLabel(pattern.startMinutes)}`,
          });
          if (suggestion) return suggestion;
        }
      }
    }

    return this.fallbackSuggestion(memberId, amenities, now);
  }

  /** The next weekday matches (start still ahead) inside the horizon. */
  private nextDatesForWeekday(pattern: QuickBookPattern, horizonDays: number, now: Date): string[] {
    const todayKey = zonedDateKey(now, this.venueTimezone);
    const dates: string[] = [];
    for (let offset = 0; offset <= horizonDays && dates.length < QUICK_BOOK_DATE_TRIES; offset += 1) {
      const dateKey = addDaysToDateKey(todayKey, offset);
      if (weekdayOfDateKey(dateKey) !== pattern.weekday) continue;
      if (wallTimeToUtc(dateKey, pattern.startMinutes, this.venueTimezone) <= now) continue;
      dates.push(dateKey);
    }
    return dates;
  }

  /**
   * The available start nearest the preferred time whose whole contiguous
   * range fits on ONE resource (union availability can lie across
   * resources, so each candidate is verified through the quote-fit port).
   */
  private async firstFittingSlot(
    memberId: string,
    amenity: HomeAmenity,
    date: string,
    options: { preferredStartMinutes: number; durationMinutes: number; reason: string },
  ): Promise<QuickBookSuggestion | null> {
    const starts = await this.bookings.listAvailableStarts(memberId, amenity.code, date);
    if (starts.length === 0) return null;

    const startSet = new Set(starts.map(timeLabelToMinutes));
    const slotCount = Math.max(1, Math.round(options.durationMinutes / amenity.slotDurationMinutes));
    const contiguous = (startMinutes: number) =>
      Array.from({ length: slotCount }, (_, i) => startMinutes + i * amenity.slotDurationMinutes).every(
        (minute) => startSet.has(minute),
      );

    const candidates = [...startSet]
      .filter(contiguous)
      .sort(
        (a, b) =>
          Math.abs(a - options.preferredStartMinutes) - Math.abs(b - options.preferredStartMinutes) || a - b,
      )
      .slice(0, QUICK_BOOK_FIT_TRIES);

    for (const startMinutes of candidates) {
      const slots = Array.from({ length: slotCount }, (_, i) =>
        minutesToTimeLabel(startMinutes + i * amenity.slotDurationMinutes),
      );
      if (await this.bookings.fitsSingleResource(memberId, amenity.code, date, slots)) {
        return {
          typeCode: amenity.code,
          typeName: amenity.name,
          date,
          startTime: minutesToTimeLabel(startMinutes),
          endTime: minutesToTimeLabel(startMinutes + slotCount * amenity.slotDurationMinutes),
          durationMinutes: slotCount * amenity.slotDurationMinutes,
          hourlyRateCents: amenity.hourlyRateCents,
          reason: options.reason,
        };
      }
    }
    return null;
  }

  /**
   * No usable history: suggest the amenity with the most open slots today
   * (an hour when a pair of slots fits, one slot otherwise), or omit the
   * suggestion when nothing is bookable.
   */
  private async fallbackSuggestion(
    memberId: string,
    amenities: HomeAmenity[],
    now: Date,
  ): Promise<QuickBookSuggestion | null> {
    const todayKey = zonedDateKey(now, this.venueTimezone);
    let best: { amenity: HomeAmenity; starts: string[] } | null = null;
    for (const amenity of amenities) {
      if (amenity.locked || amenity.resourceCount === 0) continue;
      const starts = await this.bookings.listAvailableStarts(memberId, amenity.code, todayKey);
      if (!best || starts.length > best.starts.length) best = { amenity, starts };
    }
    if (!best || best.starts.length === 0) return null;

    const preferred = timeLabelToMinutes(best.starts[0]);
    const reason = `${best.amenity.name} has the most availability today`;
    for (const durationMinutes of [best.amenity.slotDurationMinutes * 2, best.amenity.slotDurationMinutes]) {
      const suggestion = await this.firstFittingSlot(memberId, best.amenity, todayKey, {
        preferredStartMinutes: preferred,
        durationMinutes,
        reason,
      });
      if (suggestion) return suggestion;
    }
    return null;
  }

  // ── Empty state ──

  private async amenitySummary(
    memberId: string,
    amenities: HomeAmenity[],
    now: Date,
  ): Promise<HomeAmenitySummary[]> {
    const todayKey = zonedDateKey(now, this.venueTimezone);
    return Promise.all(
      amenities.map(async (amenity) => ({
        typeCode: amenity.code,
        typeName: amenity.name,
        hourlyRateCents: amenity.hourlyRateCents,
        resourceCount: amenity.resourceCount,
        locked: amenity.locked,
        availableSlotsToday:
          amenity.locked || amenity.resourceCount === 0
            ? 0
            : (await this.bookings.listAvailableStarts(memberId, amenity.code, todayKey)).length,
      })),
    );
  }
}
