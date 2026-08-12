# W5 clubs flow: notes and backend follow-ups

Gaps found while building W5. Do not paper over them client-side; each
lists where the client copes today.

## Activity feed has no participant avatars (known)

The Figma activity rows (clubs/court-booking-alt 105:5927) show a cluster
of participant avatars with a "+N" overflow. The club-activity projection
(`serializeClubActivityReservation`) intentionally serves the reduced
non-participant shape: organizer, `confirmedCount`, and the viewer's own
participation, never the roster. The client renders "Court 3 · 5 players"
plus the Upcoming badge and skips the avatar cluster. If the design
demand returns, the backend could add a bounded, names-only
`participantPreview` (first 3 confirmed: initials/avatarUrl) to the
projection without leaking the full roster.

## Booking cannot pre-associate a club from the UI (known)

The club detail's Book action and the empty feed's "Create an event" link
open `/reserve?club=<id>`, but the reserve surfaces (W3) do not read that
parameter yet, so the booking starts unlinked. The backend already
supports linkage: a reservation created with `invitees.clubIds` gets
`clubId = inviteeClubIds[0]`, and W3's invite step offers club chips, so
a member can still link the booking by adding the club chip manually.
W3 follow-up: read `?club=` in the reserve pages and pre-select that
club's chip in the wizard's invite selection.

## Non-participant activity rows are inert (known)

Reservation detail is participant-scoped (outsiders get the 404 shape),
so activity rows where `myParticipation` is null render as plain rows,
not links. A read-only club-scoped reservation view would need a new
backend read; the feed row already carries everything the Figma displays,
so nothing is lost today.

## Directory picker is a single page (known)

The invite pickers request one directory page (limit 25, the schema max)
and rely on search for everything beyond it. `GET /api/members/search`
already supports `page`; add "load more" to `ClubMemberPicker` if a
larger membership makes the first page insufficient.

## Share links: one lazily minted URL per club, shared across surfaces

The first Copy/QR/Share action mints a share link
(`POST /api/clubs/:id/invite-link`); the built join URL then lives in the
query cache (`['clubs', id, 'invite-link']`, written only by
`useClubInviteLink`), so the detail page's Share button and the invite
modal reuse the same URL and the owner's "Reset link" (rotate) swaps it
on every surface at once; nothing keeps offering a revoked token.
Multiple active links per club remain by design (per-member links,
default 30-day TTL); rotate revokes all others when a leaked URL must
die.
