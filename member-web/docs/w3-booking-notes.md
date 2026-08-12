# W3 booking flow: notes and backend follow-ups

Gaps found in the W3 review that need backend work. Do not paper over them
client-side; each lists where the client copes today.

## Venue-timezone date strip (CLOSED)

Closed by the venue-timezone pass: the backend now exposes the zone at
`GET /api/venue` and the date strip anchors on it. `todayDateKey(timezone)`
(`src/lib/booking.ts`) computes the venue-local date key with
`Intl.DateTimeFormat(..., { timeZone })`; the wizard pages (W3's
`BookingWizardPage`, W4's edit wizard) read `useVenueTimezone()`
(`src/lib/venue.ts`, `['venue']` query, cached forever, prefetched at app
start) and pass the zone into `SelectTimeStep`, whose strip is
`buildDateStrip(todayDateKey(timezone), maxAdvanceDays)`. While the query
loads (or if it fails) the hook falls back to the browser zone, and the
wizard clamps a stored date that lands in the venue's past forward to
venue-today. Convention: CONVENTIONS.md "Venue timezone".

## No fresh PaymentIntent for an existing hold (known)

A redirect payment that fails cannot be retried on the same hold because
the client secret is consumed; `RedirectReturn` (`CheckoutStep.tsx`)
releases the hold and restores the draft for a fresh hold instead. An
endpoint minting a new PaymentIntent for a pending hold would let the
member retry in place.

## Club chip count includes the inviter (known)

`clubChipLabel` (`src/lib/invites.ts`) shows the club's full member count,
but the server-side roster expansion excludes the inviter, so "(n)" can
read one higher than the number of invites actually sent.

## No member-directory listing endpoint (known)

With no search query, the invite step (`InvitePlayersStep.tsx`) can only
suggest club-mates (rosters of the member's clubs); there is no endpoint
to browse the full member directory.
