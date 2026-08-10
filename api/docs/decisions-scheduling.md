# Scheduling package (B): recorded decisions

Forks resolved while building the scheduling/reservations context, on top of
the settled critique design. OPEN-decision recommendations from
`club70-app-api-plan.md` were applied as-is where noted.

## Applied plan recommendations

1. **Cancellation refund tiers (OPEN 2, applied):** 100% more than 24h before
   start, 50% between 2h and 24h, 0% inside 2h. Cancellation itself is
   allowed until the reservation starts; the tier only governs the refund.
   Refunds go to the card on file. Lives in
   `lib/contexts/bookings/domain/cancellation-policy.ts`.
2. **Solo bookings (OPEN 5, applied):** the API allows zero invitees; the
   mobile UI may keep its own ">= 1 invitee" gate.
3. **Invite permission (OPEN 6, applied):** organizer + confirmed
   participants may add invitees (`canManageInvites`).
4. **Guests (OPEN 10, applied):** guests consume no inventory and never count
   against limits; only the organizer is limit-checked.

## Forks resolved in this package

5. **Slot labels are "HH:MM" with hours allowed past 24.** Operating hours
   past midnight produce slots like `24:00` (= 00:00 the next local day,
   still counting against the anchor date). This keeps the wire format
   unambiguous about which local date a slot belongs to and matches the
   minutes-from-midnight model. Availability responses also carry the ISO
   instant per slot.
6. **Venue timezone is config**, `VENUE_TIMEZONE` (default
   `America/New_York`), read once in the container. ClubEvents keep their
   per-row timezone column; conflict rendering uses the venue zone.
7. **Backfill rates and grids are placeholders.** Legacy courts/showers had
   no hourly rate; the migration seeds badminton at $20/h and showers at
   $10/h, and preserves the legacy per-class slot duration (60 min for
   courts) and hours. All of it is admin-editable data
   (`PATCH /api/resource-types/:id`); dev seed uses the Figma 30-minute grid.
8. **`cancellationDeadlineMinutes` is retained but not enforced.** The tier
   policy (decision 1) supersedes a hard cancellation deadline; the column
   stays as data for a future per-type override of the tier boundaries.
9. **Admin cancellations refund 100%** regardless of tier (admin compat
   routes, and reservations force-cancelled to clear the way for a club
   event): the club cancelled, not the member.
10. **Admin-created reservations are comp**: organizer = the target member,
    `createdByAdminId` set, status confirmed immediately, no hold, no
    payment rows, and the tier gate is bypassed (staff can comp a PRO
    facility).
11. **Events keep their court selection when deactivated**: event claims are
    written as `released` rows (outside the exclusion constraint's partial
    predicate) instead of being deleted, so reactivating an event does not
    lose its courts.
12. **Lost claim races map 23P01 AND 40P01 to `SlotUnavailableError`.**
    Observed against real Postgres: when two conflicting claim inserts are
    both mid-flight in the GiST index they can deadlock (40P01) instead of
    one blocking into a clean 23P01. Both mean "someone else owns the range";
    each candidate attempt runs in its own transaction, so retrying the next
    resource is sound either way.
13. **`POST /api/me/bookings` (member web portal compat)** now runs the full
    checkout (create pending_payment + confirm through the payment port) in
    one request. With the package-C stub this books end to end; with real
    Stripe it fails closed until the portal grows a PaymentSheet. The mobile
    flow uses `POST /api/reservations` + `/confirm`.
14. **Organizer removal of a participant deletes the row** (audit event
    `reservation.participant_removed` keeps the history); a later re-invite
    creates a fresh row via the `@@unique([reservationId, memberId])` upsert.
    Self-decline keeps the row (`declined`/`withdrawn`) per the critique.
15. **Audit `actorId`** is the acting principal's user id on routes (members
    and admins alike, via `req.principal.userId`); service-internal calls
    fall back to the member id; sweeper events carry `source: 'sweeper'` and
    no actor.
16. **`reservation_series` ships as schema only** (plan OPEN 8: infra + badge
    now, creation admin-only once a UI exists). The materialize-series cron
    lands together with the first creation surface; there is nothing to
    materialize until then.
17. **DST rule:** wall times convert per boundary through the venue zone
    (19:00 stays 19:00 across transitions); nonexistent/ambiguous wall times
    resolve deterministically via a two-pass offset fix-up
    (`lib/kernel/venue-time.ts`); slots straddling a transition may span
    30/90 real minutes and are priced by wall-clock duration.

## Review fixes (2026-08-10, post-package-B concurrency/domain review)

18. **Compare-and-set transitions + per-reservation advisory lock.** Every
    status write goes through `transitionStatus`/`confirmFrom`
    (`UPDATE ... WHERE status = ...`; 0 rows = lost the race, re-read and
    yield), and every mutating path on an existing reservation takes
    `pg_advisory_xact_lock(hashtext('reservation:' || id))` (member lock
    first when both are held). Kills the confirm-clobbers-cancel and
    duplicate-confirm-events races; force-release re-checks
    status/expiresAt row-by-row so a hold confirmed mid-race is skipped.
19. **Refunds are reserved in-transaction before Stripe.** The mutating
    transaction re-reads the ledger under the reservation lock and writes
    PENDING refund rows; pending refunds consume refundable balance in
    `allocateRefund`/`computeNetPaidCents`, so concurrent money paths fail
    closed instead of double-refunding. Stripe runs post-commit; a Stripe
    failure marks the row failed and restores the paid total (package C
    re-issues with idempotency keys).
20. **`pending_payment` never means uncaptured.** `cancel()` checks the
    intent first (like the sweeper): a paid hold is confirmed and then
    cancelled with the tiered refund. `confirm()` recovers an EXPIRED
    reservation whose intent captured: re-acquire the slot through the
    exclusion constraint, else refund in full. A captured charge is never
    stranded; the sub-second pay-vs-drop TOCTOU that remains is owned by
    package-C billing reconciliation.
21. **Reschedule-grow is pay-first.** The claim move for a grow is parked in
    `reservation_pending_changes` (TTL = hold TTL) and applied by
    `confirm()`/webhook/sweeper only once the delta intent succeeds; the
    delta intent is created before anything is written, so a Stripe failure
    leaves the reservation untouched, and an unpaid grow lapses without
    ever granting unpaid court time. If the target range is gone by the
    time the delta is paid, the delta refunds in full and the original
    booking stands. Cancel of a reservation with a PAID unapplied change
    refunds that delta at 100% (the time was never delivered) on top of the
    tiered base refund.
22. **Expired-but-unswept holds read as free** in availability and
    candidate computation (`listActiveInWindow` filters `expiresAt < now`),
    and create/reschedule run the payment-aware sweep over the type's
    resources before computing candidates, so the reclaim path fires
    deterministically instead of depending on the sweeper interval.
23. **Backfill pre-flight for event-vs-event overlaps.** Legacy event
    creation never checked events against each other, so step 6 of the
    backfill now RAISEs with the offending event pairs instead of aborting
    mid-INSERT on a raw 23P01.
24. **Organizer email is redacted on member surfaces.**
    `serializeLegacyBooking` includes the organizer's email only for
    `audience: 'admin'` or when the viewer is the organizer (fail-closed
    default); `/api/me/home` and `/api/me/bookings` pass the viewer.

## Package seams left open

- **Package C (billing):** `BookingPaymentPort`
  (`lib/contexts/bookings/domain/ports.ts`) with
  `StubBookingPaymentAdapter` wired in the container (`TODO(package-c)`).
  The stub fakes client secrets and reports instant success. C replaces it
  with on-session PaymentIntents + `payment_intent.succeeded` webhook
  confirmation (the webhook calls `reservationService.confirm`), real
  refunds, and reconciliation of optimistically-recorded refunds.
- **Package D (clubs):** `Reservation.clubId` and
  `ReservationParticipant.viaClubId` are plain nullable columns;
  `invitees.clubIds` on create returns 422 `NOT_IMPLEMENTED`
  (`TODO(package-d)`).
- **Package F (notifications):** the outbox dispatcher
  (`lib/infrastructure/outbox.ts`, `POST /api/cron/dispatch-outbox`) feeds a
  `NoopOutboxSink` (`TODO(package-f)`); F swaps in the real consumer.

## Validation record (2026-08-10)

Full migration chain applied twice against a throwaway Postgres 16
container: once on a legacy-shaped database with fixture data (overlapping
confirmed bookings, a 23:00-24:00 booking, an event/booking conflict) and
once on an empty database + seed. `prisma migrate diff` reported zero drift
both times. Live checks: concurrent overlapping claim inserts (one winner,
loser 23P01/40P01), self-excluding claim UPDATE, advisory-lock
serialization, and an end-to-end service run (racing creates landing on
different courts, confirm, respond, reschedule with guest reset + refund
delta, tiered cancel, event-conflict listing, outbox drain).

Review-fix validation (2026-08-10, throwaway Postgres 16): full chain incl.
`reservation_pending_changes` applied to an empty database, zero drift.
Live interleavings under READ COMMITTED: (a) confirm commits between
force-release's SELECT and its writes: the reservation CAS re-checks via
EvalPlanQual and skips, final state confirmed + active claim, overlapping
insert still loses 23P01; (b) force-release wins the row first: the late
confirm CAS returns 0 rows instead of resurrecting the reservation, and
recovery re-arms the released claim; (c) recovery against a re-claimed
range loses 23P01 (mapped to the full-refund path); pending-change
uniqueness and cascade verified. Backfill pre-flight: two overlapping
active events on one court abort the migration with the offending pair
named; after deactivating one, the backfill completes (active + released
event claims as expected).
