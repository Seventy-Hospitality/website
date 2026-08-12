/**
 * Public surface of the booking feature (M3). M2 (home) and M4
 * (reservations) import the reusable reservation card/slot components, the
 * amenity icon, the shared formatters, and the query definitions from here
 * so the whole app renders reservations one way and shares query keys for
 * cache invalidation.
 */

// ── Screens / routes ──
export { ReserveScreen } from './ReserveScreen';
export { BookingWizardScreen } from './BookingWizardScreen';

// ── Reusable reservation components (M2 home cards, M4 detail) ──
export {
  ReservationSummaryCard,
  type ReservationSummaryCardProps,
  type ReservationSummaryRow,
} from './ReservationSummaryCard';
export { SlotPill } from './SlotPill';
export { ResourceTypeIcon, ResourceTypeTile, resourceTypeGlyph } from './ResourceTypeIcon';

// ── Shared formatters + slot/date math (M2/M4 render the same shapes) ──
export * from './booking';
export type { SelectionSummary } from './booking';

// ── Invite-selection helpers + types ──
export {
  EMPTY_INVITE_SELECTION,
  inviteCount,
  inviteesPayload,
  memberDisplayName,
  memberNumberLabel,
  type InviteSelection,
  type InviteClub,
} from './invites';

// ── Query definitions (shared keys) + entitlement + venue tz ──
export {
  resourceTypesQuery,
  availabilityQuery,
  myClubsQuery,
  memberSearchQuery,
  venueQuery,
  membershipQuery,
  isEntitledMembershipStatus,
  useVenueTimezone,
  type MembershipView,
} from './booking-data';

// ── Reservation TYPES re-exported for M2/M4 convenience ──
export type {
  Reservation,
  ReservationParticipant,
  ReservationParticipantStatus,
  ReservationStatus,
  ReservationViewer,
  ReservationQuote,
  CreateReservationResult,
  ResourceTypeSummary,
  AvailabilityDay,
  AvailabilitySlot,
  MemberSearchResult,
} from '../../lib/api';
