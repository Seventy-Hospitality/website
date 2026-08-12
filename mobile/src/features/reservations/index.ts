/**
 * Public surface of the reservations feature (M4). M2 (home) imports the
 * shared respond hook for its inline invitation accept/decline so both the
 * home cards and the detail screen share one optimistic cache discipline.
 */

// ── Screens ──
export { ReservationDetailScreen } from './ReservationDetailScreen';
export { RescheduleWizardScreen } from './RescheduleWizardScreen';
export { InviteMoreScreen } from './InviteMoreScreen';

// ── Shared respond mutation (M2 home reuses this for inline accept/decline) ──
export {
  useRespondToReservation,
  isRespondConflict,
  applyResponseToDetail,
  applyResponseToHome,
  type RespondInput,
} from './useRespondToReservation';

// ── Query definitions (shared ['reservations', id] key) ──
export { reservationQuery } from './reservations-data';

// ── Pure lifecycle logic (previews + optimistic UI) ──
export {
  cancelRefundPreview,
  refundPercentFor,
  computeRefundCents,
  applyParticipantResponse,
  describeRescheduleMoney,
  isSelectionChanged,
  reservationSlots,
  selectionTarget,
  reservationMatchesMove,
  hasReservationStarted,
  isActiveReservationStatus,
  type ParticipantResponse,
  type RescheduleMoney,
  type MoveTarget,
  type CancelRefundPreview,
} from './reservation-policy';
