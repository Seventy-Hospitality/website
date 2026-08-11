# W2 home flow: notes and follow-ups

Same discipline as `w3-booking-notes.md` / `w4-reservation-notes.md`:
gaps found while building the home feed, with where the client copes
today.

## Quick-book "Book now" does not prefill the wizard yet (W3 follow-up)

The suggestion card deep-links to
`/reserve/:typeCode?date=YYYY-MM-DD&start=HH:MM&end=HH:MM`, but
`BookingWizardPage` only reads `reservation` (resume) and
`redirect_status` from the query string, so the member lands on the
right amenity with TODAY selected and re-picks the suggested slot. The
params are already in the URL; when W3 picks this up, initialize the
wizard's `date` from `?date=` (validated against the horizon) and
preselect `slotsFromRange(start, end, slotDurationMinutes)` when those
slots are still available.

## Quick book is hidden in the empty state (by design)

The backend computes `quickBook` even for a member with nothing
upcoming (the availability fallback suggests a slot to brand-new
members). The Figma empty-state frame (174:16152) shows only the
"book your first session" banner + the amenity list, so the client
renders the quick-book card only in the non-empty layout; the banner is
the call to book.

## Empty-state selection is server-driven

`amenities !== null` on GET /api/me/home IS the empty state (the server
sends it only when nothing is upcoming and no reservation invitations
are pending). After the LAST pending invitation is declined, the
optimistic write empties both lists while `amenities` is still null;
the page shows a small "Nothing coming up" state until the settle-time
refetch delivers the amenity summary. Accepted as a sub-second gap.

## Legacy `upcomingBookings` field is ignored

The home payload still carries the old member-portal `upcomingBookings`
list for existing clients; this client types and consumes only the new
fields (`HomeFeed` in `src/lib/api.ts`).

## Spotlight events are display-only

There is no member-facing event detail endpoint or route, so the cards
(image, title, date, time in the event's `timezone`) are not links. If
events grow a detail surface, make the whole card the link.

## Member QR is light-on-dark (per the Figma)

The card renders white modules on the dark surface (107:9461). Some
third-party scanner apps refuse inverted codes; the staff gate scanner
is ours (POST /api/qr/verify), so this is fine, but revisit if members
ever need to scan it with arbitrary apps. The 60s token TTL is handled
by re-requesting 10s before expiry while the sheet is open.
