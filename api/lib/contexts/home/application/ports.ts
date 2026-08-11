import type { ReservationDetailRecord } from '@/lib/contexts/bookings';
import type { PendingInvitationItem } from '@/lib/contexts/clubs';
import type { ClubEvent } from '@/lib/contexts/events';
import type { BookingHistoryEntry } from '../domain';

// Ports out of the home read context. Home is pure composition: it reaches
// every other context ONLY through these shapes, wired in the container
// over the public barrels (bookings' ReservationService reads, clubs'
// invitation read, events' listing, members' profile).

export interface HomeMemberProfile {
  id: string;
  firstName: string;
  displayName: string | null;
}

export interface HomeMembersPort {
  getProfile(memberId: string): Promise<HomeMemberProfile | null>;
}

export interface HomeAmenity {
  code: string;
  name: string;
  hourlyRateCents: number;
  locked: boolean;
  resourceCount: number;
  slotDurationMinutes: number;
  maxAdvanceDays: number;
}

export interface HomeBookingsPort {
  /**
   * Whether the member's membership currently entitles them to book at all.
   * Amenity `locked` is tier-only; a lapsed membership locks everything
   * (quick-book must never suggest a slot the booking write rejects).
   */
  hasActiveMembership(memberId: string): Promise<boolean>;
  /** Everything the member organizes or participates in, soonest first. */
  listUpcomingForMember(memberId: string): Promise<ReservationDetailRecord[]>;
  /** Recent PAST confirmed bookings as organizer, most recent first. */
  listRecentConfirmedHistory(memberId: string): Promise<BookingHistoryEntry[]>;
  /** Active amenity types with tier lock + unit counts for this member. */
  listAmenitiesForMember(memberId: string): Promise<HomeAmenity[]>;
  /** Free "HH:MM" slot starts for one type + venue-local date (unioned). */
  listAvailableStarts(memberId: string, typeCode: string, date: string): Promise<string[]>;
  /** Whether ONE resource can host the whole contiguous slot selection. */
  fitsSingleResource(memberId: string, typeCode: string, date: string, slots: string[]): Promise<boolean>;
}

export interface HomeClubsPort {
  listPendingInvitations(memberId: string): Promise<PendingInvitationItem[]>;
}

export interface HomeEventsPort {
  listUpcoming(): Promise<ClubEvent[]>;
}
