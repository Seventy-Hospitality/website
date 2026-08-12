// Home bounded context (package F): the home-screen READ composition. Owns
// no tables; composes bookings, clubs, events and members through narrow
// container-wired ports over their public barrels, plus the pure greeting
// and quick-book heuristics in its domain. Rationale recorded in
// docs/decisions-notifications.md.

export {
  HomeService,
  type HomeView,
  type HomeGreeting,
  type QuickBookSuggestion,
  type HomeAmenitySummary,
  type HomeMembersPort,
  type HomeMemberProfile,
  type HomeBookingsPort,
  type HomeAmenity,
  type HomeClubsPort,
  type HomeEventsPort,
} from './application';
export {
  deriveQuickBookPattern,
  timeOfDayFor,
  isValidTimeZone,
  canonicalTimeZone,
  WEEKDAY_NAMES,
  type BookingHistoryEntry,
  type QuickBookPattern,
  type TimeOfDay,
} from './domain';
