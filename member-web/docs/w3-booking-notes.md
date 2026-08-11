# W3 booking flow: notes and backend follow-ups

Gaps found in the W3 review that need backend work. Do not paper over them
client-side; each lists where the client copes today.

## Venue-timezone date strip (open)

`todayDateKey()` / `buildDateStrip` (`src/lib/booking.ts`) anchor the
wizard's date strip on the DEVICE timezone, while the backend defines
"today" and the booking horizon in `VENUE_TIMEZONE`
(`api/src/lib/container` -> `reservation.service`). Near a date boundary a
member whose device is in a different timezone sees a strip that is off by
one day: the first tile can already be in the venue's past (empty
availability), and the true last bookable venue day is missing.

Fix when picked up: expose the venue timezone (or venue-local "today") on
the API, e.g. on `GET /api/resource-types` or a config endpoint, then
compute the strip with `Intl.DateTimeFormat(..., { timeZone })` instead of
device-local `new Date()`. Accepted as a known minor until then:
single-location club, essentially local member base, and empty
availability already disables Continue so no invalid create is sent.

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
