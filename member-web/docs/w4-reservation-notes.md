# W4 reservations flow: notes and backend follow-ups

Same discipline as `w3-booking-notes.md`: gaps found while building the
detail/edit/cancel/respond surfaces, with where the client copes today.

## Venue-timezone date strip in the edit wizard (CLOSED)

W3's device-timezone date strip gap applied to the edit wizard too (it
reuses `SelectTimeStep`). Closed by the venue-timezone pass: `EditWizard`
reads `useVenueTimezone()` (`src/lib/venue.ts`, backed by the new
`GET /api/venue`) and passes the zone to `SelectTimeStep`, whose strip
anchors on `todayDateKey(timezone)`. Details in `w3-booking-notes.md`;
convention in CONVENTIONS.md "Venue timezone".

## No availability self-exclusion on the member endpoint (known)

`ReservationService.getAvailability` supports `excludeReservationId` (the
edit screen's self-exclusion), but the member route
`GET /api/resource-types/:code/availability` does not accept it, so the
reservation's own claim reads as taken in the response. The edit wizard
(`EditReservationPage`) merges the reservation's own slots into the
fetched day client-side (`mergeOwnSlots` + `extraAvailable` on
`SelectTimeStep`), which is correct because the backend PATCH self-excludes
the reservation when validating candidates. Residual: the member cannot see
that a NEIGHBORING slot only frees up because their own booking would move
off it (rare; the PATCH still validates server-side).

Fix when picked up: accept `excludeReservationId` on the availability
route (participant-checked) and drop the client-side merge.

## No client-cancel for a parked reschedule change (by design, noted)

A grow reschedule parks a pending change with a fresh PaymentIntent.
Backing out of the edit wizard cannot void it client-side (DELETE cancels
the whole reservation), so the W4 hold session uses a NO-OP cancel: an
unpaid change lapses at its TTL and any newer PATCH supersedes it
server-side. Consequence: after a back-out, the change (and its unpaid
intent) lingers up to ~12 minutes; the detail page shows it to the
organizer as an "awaiting payment" banner. An explicit
`DELETE /api/reservations/:id/pending-change` would remove that window.

## Redirect-payment retry on a change delta (same class as W3's gap)

W3's "no fresh PaymentIntent for an existing hold" applies to change
deltas too: after a failed redirect payment the delta's client secret is
consumed, so the edit flow treats it as "payment not completed", lets the
parked change lapse, and the member re-picks the time (a fresh PATCH mints
a fresh intent). No money risk; one extra step for the member.

Related: "no pending change" on the confirm read-back is NOT proof the
move applied; the backend also clears a parked change it dropped (lapsed
at its TTL, superseded, or slot gone at settle time, delta auto-refunded)
and then returns the unmoved original. Both settle paths therefore verify
the reservation actually sits on the requested date and time
(`reservationMatchesMove` in `reservation-policy.ts`); the redirect return
leg restores that target from `to_date`/`to_start`/`to_end` params the
edit wizard puts on the Stripe return URL. A mismatch is reported as
"unchanged, refunded automatically", never as an updated booking.

## Cancellation refund preview is a client mirror (accepted)

The cancel dialog previews the tier (100% >24h, 50% 2-24h, 0% inside 2h)
from `reservation-policy.ts`, mirroring
`api/lib/contexts/bookings/domain/cancellation-policy.ts`; the DELETE
response's `refundCents` is what is actually shown in the success toast.
If the policy ever changes server-side, the mirror must follow; a
`refund-preview` field on GET detail would remove the duplication.
