// Persistence abstractions (no concrete implementations)
export { UnitOfWork, type TransactionContext } from './unit-of-work';

// Payment-ledger math (pure; the ONE net-paid / refund-allocation
// implementation, shared by the bookings settlement and billing contexts)
export {
  type PaymentLike,
  type PaymentRowKind,
  type PaymentRowStatus,
  type RefundAllocation,
  computeNetPaidCents,
  computeRefundableCents,
  allocateRefund,
  InsufficientRefundableBalanceError,
} from './payment-allocation';

// Venue time math (pure; shared by the scheduling and events contexts)
export {
  type ZonedParts,
  getZonedParts,
  zonedDateKey,
  wallTimeToUtc,
  zonedMinutesSinceMidnight,
  addDaysToDateKey,
  minutesToTimeLabel,
  timeLabelToMinutes,
} from './venue-time';
