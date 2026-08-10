# Clubs package (D): recorded decisions

Forks resolved while building the clubs context (member-created social
clubs), on top of the settled plan. OPEN-decision recommendations from
`club70-app-api-plan.md` were applied as noted.

## Applied plan recommendations

1. **Club invites require acceptance (OPEN 4, applied).** An invitation is a
   `club_invitations` row that stays `pending` until the invitee accepts or
   declines; membership rows are created ONLY by an accepted invitation or a
   link join. Direct-add does not exist anywhere in the API. This matches
   the invite-link and reservation-invite semantics.

## Forks resolved in this package

2. **Public member id = `member.id`.** The plan sketches a `memberNumber`,
   but neither package A nor B introduced one: the member directory search
   (`GET /api/members/search`) returns `{ id, firstName, lastName }`. The
   roster therefore exposes `memberId`, the same identifier the directory
   returns, rather than inventing a second member-ID scheme. When a real
   member-number lands (package E profile work), the roster field is the
   single place to carry it.
3. **Club-invite expansion is a SNAPSHOT at invite time.** A club chip on a
   booking expands to the club's CURRENT member roster when the invite is
   made, creating `reservation_participants` rows with `viaClubId`
   provenance, each `pending`. Members who join the club later do NOT join
   existing reservations; leaving the club does not withdraw an invitation
   already sent. Skips: the organizer/inviter, anyone already invited
   (upsert against `@@unique([reservationId, memberId])`), and a
   directly-picked member keeps `viaClubId = null` (direct invite outranks
   club provenance; first club wins when several clubs share a member).
4. **`reservations.clubId` = the FIRST club chip.** The wire format allows
   several club chips on one booking; participants carry exact per-club
   provenance, and the reservation's own club linkage (which feeds
   `GET /api/clubs/:id/activity`) is the first club named. The mobile flow
   books from inside one club, so in practice there is exactly one.
5. **Cross-club invite authz keys on the ACTING inviter.** On create the
   organizer, on `POST /reservations/:id/participants` the inviting
   participant, must be a member of every club named ("you share YOUR
   club"). A club the inviter is not in answers exactly like a club that
   does not exist (404 shape, `ClubInviteNotAllowedError`), so the invite
   path cannot probe club ids.
6. **Single-owner model.** Every club has exactly one owner at all times,
   enforced in the service under a per-club advisory lock
   (`pg_advisory_xact_lock(hashtext('club:' || id))`) with pure domain
   rules: promoting another member is a transfer (they become owner, the
   actor is demoted in the same diff); the owner cannot demote themselves,
   be removed, or leave without transferring first (delete remains
   available). Outsiders get 404 on every club id; members get 403 on
   owner-only actions.
7. **Ownership-transfer tiebreak on account deletion: longest tenure, then
   member id.** The deletion seam (`releaseMemberForAccountDeletion`)
   transfers each owned club to the earliest-joined remaining member,
   breaking joinedAt ties on member id for determinism; a club with nobody
   left is deleted. Plain memberships are removed and every pending
   invitation the member sent OR received is `revoked`. TODO(package-e)
   marks where the deletion pipeline calls it.
8. **Invitation history is append-mostly.** Responding never deletes rows:
   decline/revoke keep the row and a re-invite is a NEW row. At most one
   PENDING row per (club, invitee) is enforced by a partial unique index
   (raw SQL, like the slot_claims exclusion constraint; Prisma cannot
   express partial uniques, and `prisma migrate diff` ignores them, so the
   drift check stays clean). Inviting an existing member or an
   already-pending invitee is a silent no-op ("invite all" semantics).
9. **Invite links: hashed at rest, one raw reveal, member-mint,
   owner-rotate.** Tokens reuse the identity domain's generateToken/
   hashToken (32 random bytes, sha256 stored); the raw token leaves the API
   exactly once, in the `POST /clubs/:id/invite-link` response (the client
   builds the share URL and QR from it). Any club member may mint a link
   (the Figma invite modal is open to members), default TTL 30 days,
   optional `maxUses`; `rotate: true` additionally revokes every other
   active link and is owner-only (that is the "revoke invite links" owner
   power, and how a leaked link is killed). Several live links may coexist
   otherwise.
10. **Join-via-link is idempotent BEFORE the link verdict.** An existing
    member re-presenting a token answers success without consuming a use,
    even if the link is now exhausted/rotated, so a retry whose first
    attempt consumed the last use never 410s (caught by the live DB
    validation). For non-members, expiry/maxUses/revocation are re-checked
    INSIDE the consuming UPDATE (column-to-column `useCount < maxUses`, raw
    SQL), so racing joins cannot overshoot a limit; joining via link marks
    any pending invitation to that club accepted.
11. **`clubId`/`viaClubId` become real FKs with ON DELETE SET NULL.**
    Package B shipped them as plain nullable strings ("FK-to-be"); deleting
    a club now unlinks its reservations and participant provenance instead
    of stranding dangling ids. Club deletion cascades members, invitations
    and links.
12. **Cover images ride the existing event-image pipeline.** Same
    ManagedMediaAsset lifecycle, MIME/size limits, sharp normalization and
    storage backends, attached with `ownerType: 'club'`; a replaced or
    removed cover's asset is deleted after the DB write, and the
    stale-pending cleanup's referenced-asset safety net now also checks
    `clubs.coverImageUrl`. A dedicated `club-cover` usage/directory was
    deliberately not introduced: the lifecycle is identical and the public
    path is opaque.
13. **`POST /api/clubs/invite-preview` is an extra endpoint** (not in the
    plan table): the scope's "non-members resolve an invite link/QR to a
    preview + join" needs a resolve step that does not consume a use. Same
    `member` policy and 410 mapping as join.
14. **Route policy is `member` everywhere; club-level roles live in the
    service.** The ladder only establishes "facility member"; every club
    action re-derives outsider/member/owner from `club_members` inside the
    service (IDOR answers: outsider 404, member-on-owner-action 403,
    only-invitee-can-respond 404).
15. **The activity feed serves a reduced, non-participant projection**
    (review fix, 2026-08-10). Club membership is not booking participation:
    `GET /api/clubs/:id/activity` emits per booking only schedule/resource
    fields, the organizer's identity, a confirmed-attendee count, and the
    viewer's OWN participation (`myParticipation`). Financials
    (`amountPaidCents`, `hourlyRateCents`), per-guest RSVP statuses, the
    invitedBy graph and the roster (which can include direct invitees who
    are not club members) stay participation-gated behind
    `GET /api/reservations/:id`, which 404s non-participants; the feed must
    never serve what the detail endpoint withholds
    (`serializeClubActivityReservation`).
16. **Invitation withdrawal is compare-and-set** (review fix, 2026-08-10).
    The account-deletion seam revokes pending invitations in clubs the
    member may already have LEFT, which the per-club advisory-lock loop
    does not cover; each revoke therefore re-checks `status = 'pending'`
    in the UPDATE itself (like every other invitation transition) and only
    rows actually revoked are returned/audited, so a concurrently-accepted
    invite keeps its `accepted` status and membership row.

## Notification/outbox events for package F

Appended via `EventStore.append` in the mutating transaction (streamType
`club`, streamId = club id, actorId = the acting principal's user id), and
dispatched by the existing outbox cron to the package-F sink:
`club.created`, `club.updated`, `club.deleted`, `club.invitation_sent`,
`club.invitation_accepted`, `club.invitation_declined`,
`club.invitation_withdrawn`, `club.member_joined` (data.via =
`invitation | link`), `club.member_left`, `club.member_removed`,
`club.ownership_transferred`, `club.invite_link_created`,
`club.invite_link_revoked`. Club-expanded reservation invites reuse
`reservation.participant_invited` with `viaClubId` in the payload.

## Validation record (2026-08-10)

Full migration chain (through `20260810210000_clubs`) applied to a
throwaway Postgres 16 container; `prisma migrate diff` (applied DB vs
schema datamodel) reported zero drift, partial unique index included. Live
checks through the real services and repositories: partial-unique rejection
of a second pending invite + re-invite after decline; invite-link
maxUses boundary, expiry, member-mint/owner-rotate, rotation revoking prior
links, idempotent re-join (which caught and fixed the
retry-after-exhaustion 410 bug); club-chip reservation expansion (roster
snapshot, organizer skipped, provenance rows) and cross-club rejection;
ownership transfer then leave; account-deletion seam transferring to the
longest-tenured member and deleting a sole-member club; club deletion
SET-NULLing reservation linkage; all club.* audit rows present and
undispatched (outbox-ready).
