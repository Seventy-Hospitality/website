/**
 * Pure home-layout selection (package M2). The backend drives which layout
 * the feed renders; this module reads that off the payload so the composition
 * and its tests agree. Mirrors member-web/src/pages/home/HomePage.tsx's
 * top-of-render derivation.
 */
import type { HomeFeed, Reservation } from '../../lib/api';

export interface HomeLayout {
  /**
   * The first-session empty state. The backend sends `amenities` ONLY when
   * nothing is upcoming and no reservation invitations are pending, so its
   * presence (not null) selects the empty layout.
   */
  isEmpty: boolean;
  /** There is at least one upcoming reservation or pending invitation to show. */
  hasUpcoming: boolean;
  /** Show the quick-book card (non-empty layout only, and only when present). */
  showQuickBook: boolean;
  /** Show the club-invitations section. */
  showClubInvitations: boolean;
  /** Show the spotlight-events rail. */
  showSpotlight: boolean;
}

export function homeLayout(feed: HomeFeed): HomeLayout {
  const isEmpty = feed.amenities !== null;
  const hasUpcoming =
    feed.pendingInvitations.length > 0 || feed.upcomingReservations.length > 0;
  return {
    isEmpty,
    hasUpcoming,
    showQuickBook: !isEmpty && feed.quickBook !== null,
    showClubInvitations: feed.clubInvitations.length > 0,
    showSpotlight: feed.spotlightEvents.length > 0,
  };
}

/** Confirmed + pending players, the count the Figma cards show. */
export function playerCountLabel(reservation: Reservation): string {
  const count = reservation.participants.filter(
    (row) => row.status === 'confirmed' || row.status === 'pending',
  ).length;
  return count === 1 ? '1 player' : `${count} players`;
}

/** The eyebrow above the member's first name in the greeting header. */
export function greetingEyebrow(
  timeOfDay: HomeFeed['greeting']['timeOfDay'],
  isEmpty: boolean,
): string {
  if (isEmpty) return 'Welcome,';
  switch (timeOfDay) {
    case 'morning':
      return 'Good morning,';
    case 'afternoon':
      return 'Good afternoon,';
    case 'evening':
    default:
      return 'Good evening,';
  }
}
