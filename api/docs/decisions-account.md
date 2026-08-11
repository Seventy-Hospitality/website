# Account package (E): recorded decisions

Forks resolved while building the account surface (profile, member number,
QR card, notification preferences, devices, ID verification, account
deletion), on top of the settled plan. Settled OPEN decisions applied:
refund destination = card (7, settled in package C), stats window =
lifetime (9). "Claim Clutch session stats" is parked and not built.

## Member number

1. **Format: one uppercase letter + five digits ("A12345"), shown with a
   leading `#`.** The alphabet excludes I and O (confusable with 1 and 0).
   Random, not sequential: a public identifier must not leak member count
   or join order. Uniqueness is the DB unique index; the members
   repository retries fresh candidates on a collision (inspecting the
   P2002 target so an email duplicate still maps to DuplicateEmailError),
   and the identity signup seam pre-checks candidates instead (a unique
   violation inside its transaction would abort the whole signup).
2. **Backfill** ran in migration `20260811090000_account_member_profile`
   with the same alphabet, a per-row retry loop in SQL.
3. **Retired forever.** Deletion anonymizes the member row but keeps its
   memberNumber; the surviving row + unique index guarantee a number is
   never reassigned. It is never an auth identifier.
4. **Wired through package D's reads**: directory search matches
   name-prefixes OR member-number prefixes (`#` optional, case-insensitive)
   and returns memberNumber/displayName/avatarUrl; club rosters carry the
   member number as D reserved space for. Deleted members never surface in
   search (`deletedAt IS NULL`).

## Profile

5. **displayName is distinct from firstName/lastName** and optional;
   presentation falls back to "First Last" (`memberDisplayName`). PATCH
   /api/me/profile edits only the display name; legal names stay
   admin-managed. Blank clears to null; 60-char cap.
6. **memberSince = members.createdAt.** The club profile's creation date,
   not the user account's (a staff-created member predating signup shows
   the earlier, correct date).
7. **Avatar initials fallback is a CLIENT concern**: avatarUrl stays null
   until a photo is uploaded. Avatars ride the media pipeline under their
   own public usage (512px cover webp, no GIF: the animated pass-through
   would skip the square crop). Replacing deletes the old asset.

## Activity stats (lifetime)

8. **Definition: the member's CONFIRMED reservations as ORGANIZER,
   lifetime, no time window.** Future confirmed bookings count ("courts
   booked" means booked, not played); pending/cancelled/expired never
   count. Guests do not accrue stats (decision 10: guests do not consume
   inventory).
9. **Hours = sum of scheduled durations (endsAt - startsAt) per court
   family.** Instant differences, so DST cannot bend them. Family mapping
   (`bookings/domain/activity-stats.ts`): `badminton_court` -> badminton,
   `tennis_court` -> tennis; simulators, mahjong tables and showers belong
   to no family and are excluded from both the count and the hours.
   Serialized as decimal hours (minutes/60; 30-minute slots give .5
   granularity). The aggregation lives in the bookings read side
   (`reservationService.getLifetimeActivityStats`), consumed by the
   profile route; no other context touches the reservations table.

## Member QR card

10. **Payload is a short-lived signed token, never the raw member id or
    number** (a screenshot must go stale). Format:
    `MQR1.<base64url {"m":memberId,"iat":s,"exp":s}>.<base64url HMAC-SHA256>`,
    TTL 60 seconds, signature over `MQR1.<payload>`. Key = sha256 of
    `MEMBER_QR_SECRET` (or, unset, of `JWT_SECRET + ":member-qr"`), so the
    QR credential never signs with the raw JWT secret.
11. **Verification re-reads the member row**: a deleted member's
    still-fresh token is refused (the general rule: any capability
    verified without a fresh principal read needs a deletedAt check).
    Issue = GET /api/me/qr (member, 30/min); verify = POST /api/qr/verify
    (staff) answering the member identity + membership status. Expired is
    410 QR_EXPIRED (refresh the code); tampered/malformed/unknown all
    collapse into one opaque 404 QR_INVALID.

## Notification preferences and devices

12. **Owned by the communications BC**, not a new account context: package
    F's outbox consumers read them to gate and target delivery, and making
    the sender import an "account" context to send a push would be
    backwards. TODO(package-f) marks the consumption point.
13. **Toggles save independently**: the upsert's update clause carries ONLY
    the keys present, so a stale client saving one switch cannot clobber
    the others. Absent row = all defaults (true).
14. **Devices are keyed on the globally-unique push token**: re-register
    refreshes lastSeenAt; a device that changed hands moves to its new
    member (one delivery target per physical device). Unregister only
    matches caller-owned tokens and is idempotent.

## ID verification (private storage)

15. **The photo is a PRIVATE media asset**: stored under a bare
    `private/id-photos/<name>` key that no route serves (public assets are
    `/uploads/...`; the path-shape invariant makes confusion structurally
    impossible), encrypted at rest with AES-256-GCM under
    `MEDIA_ENCRYPTION_KEY` (its own key so a JWT_SECRET rotation cannot
    brick stored photos; required in production), decrypted in memory and
    fully authenticated before a byte is served. On the local backend the
    private root has no ancestor relationship with `uploads/`; on S3 the
    keys live under `private/` with SSE as a second layer.
16. **Exactly one way out of the API**: GET
    /api/id-verifications/:memberId/photo, policy staff, `no-store` +
    `nosniff`, and every view appends an `id_verification.photo_viewed`
    audit event. Members cannot fetch any ID photo, their own included.
17. **State machine**: uploads (and replacements) allowed while
    not_submitted or rejected; frozen while submitted and after verified;
    submit requires a photo; skip records skippedAt without changing
    status; review is a compare-and-set on status=submitted (two staff
    racing produce one decision) with a member-visible rejection note.
    The photo WRITE is compare-and-set too (uploadable states only): an
    upload whose slow normalize raced a concurrent submit loses cleanly,
    the just-uploaded asset is discarded, and the under-review photo
    survives untouched — the freeze holds under concurrency, not just on
    the pre-read.
18. **Short retention**: the deciding transaction nulls the photo pointer
    and the object is deleted after commit; replacement deletes the old
    asset; account deletion purges photo and row. `purgedAt` on
    managed_media_assets is the proof the object is actually gone
    (discard -> delete -> purge, with a sweeper retry in between).

## Account deletion

19. **Step-up proofs** (verified once, when the request is CREATED; an
    existing request resumes without new proof):
    - password: argon2 verify of the current password (timing-equalized
      when no credential exists).
    - oauth: fresh provider assertion via the existing verifiers +
      oauth_nonce burn, AND the asserted (provider, subject) must already
      be linked to this user (a valid token for the attacker's own Google
      account proves nothing).
    - reauth_email: a dedicated `reauth` token purpose (10 min TTL),
      identifier = userId, bindingHash = sha256(sessionId) - subject- and
      session-bound. Deliberately NOT the magic-link purpose: magic links
      are minted by an unauthenticated endpoint for any account, and
      consuming one as deletion proof would let a hijacked session destroy
      the account with a link for the attacker's own inbox.
    403 STEP_UP_REQUIRED lists the account's acceptable methods; DELETE
    /api/me and POST /api/me/reauth-email are rate-limited per USER
    (5/15min and 3/15min): the password branch is an online guessing
    oracle an IP-keyed limit cannot contain.
20. **Quiesce before destruction, on every entry.** The freeze — stamp
    users.deletionRequestedAt (never cleared; no undo), revoke every
    OTHER session, delete push devices — is the pipeline's FIRST step,
    not creation-only code: a request row that persisted moments before a
    transient quiesce failure re-applies the freeze on every resume path
    (user retry or cron) before anything destructive runs. The auth
    ladder answers 409 DELETION_IN_PROGRESS for every policy above
    `authenticated`, read fresh per request, so a half-deleted account
    cannot book, pay or create anything on any device while the saga
    completes. A user retry spares its driving session; a cron resume
    spares none (nobody is driving).
21. **Steps** (deletion_requests.steps json: completedAt/attempts/
    lastError/result per step; the result payloads feed the final event
    and are the only record once the rows are scrubbed):
    quiesce (decision 20) ->
    cancel_reservations (organizer, startsAt strictly future, tier refund
    policy, in-progress reservations left alone, re-listed every run so
    re-runs converge) -> release_participations (guest pending/confirmed
    declined/withdrawn via the bookings seam) -> close_billing (cancel
    subscription now, detach PMs, tag customer, NEVER customers.del(),
    ledger kept) -> release_clubs (transfer/delete, invitations withdrawn,
    share links minted by the member revoked) -> revoke_apple ->
    erase_credentials -> tombstone_user -> scrub_member ->
    purge_id_verification -> finalize.
22. **The billing gate splits hard vs soft.** Entry (before anything is
    persisted): open dispute OR refund-in-flight OR pending ledger rows
    block with 409 DELETION_BLOCKED. Mid-pipeline, closeBillingForMember
    re-checks ONLY the dispute half: the pipeline's own cancellation step
    legitimately creates pending refunds, and re-checking them would wedge
    the very flow that made them. A dispute arriving mid-pipeline flips
    the request to `blocked` with an alert event; no auto-retry.
23. **Apple revoke comes BEFORE identity deletion** (deleting first would
    destroy the only copy of the refresh token and make revocation
    permanently impossible). invalid_grant counts as success; transient
    failures and an unconfigured gateway WITH a stored token are
    retryable step failures; a ciphertext the current key cannot decrypt
    (secret rotated) is classified `undecryptable` and recorded, not
    fatal. One-time tokens are burned in erase_credentials - magic links
    by the PRE-tombstone email (they key on email), everything else by
    userId.
24. **Tombstones**: users get status='deleted' + `deleted+<userId>@invalid`
    (a deleted account authenticates nowhere: session validation, sign-in,
    magic link and reset all check status, and validation answers a
    distinct 401 ACCOUNT_UNAVAILABLE so clients purge tokens); members are
    scrubbed to "Deleted Member", phone/avatar/displayName cleared, email
    `deleted+<memberId>@invalid`, userId nulled, deletedAt set -
    keeping the row (reservation/ledger FKs), the memberNumber (retired)
    and stripeCustomerId (dispute windows; billing tags the Stripe
    customer). Re-signup with the same email or provider starts a FRESH
    account and never inherits the old profile.
25. **Resumability**: user retries of DELETE /api/me resume while their
    session lives; after erase_credentials only POST
    /api/cron/resume-deletions can finish the job (it selects due
    requests, exponential backoff 1m..6h). A lockedBy/lockedUntil lease
    (5 min TTL, renewed by every completed step, so the TTL budgets a
    step, never the whole pipeline) keeps a user retry and the cron from
    driving one request concurrently; a crashed run resumes after the
    lease expires. Every subsequent write (step save, failure, blocked,
    completion) is compare-and-set on lockedBy, and a claim answers the
    freshly-leased row: a worker whose expired lease was stolen mid-run
    abandons on its next write instead of double-driving from a stale
    snapshot. 20 total attempts flip the request to `blocked` with an
    alert. The finalize step commits the `account.deleted` outbox event
    (package F's consumer) in the SAME transaction as status='completed',
    with the lease CAS inside that transaction — a deletion is never
    announced unfinished, and never announced twice. No 30-day undo.
26. **Post-deletion money keeps moving deliberately**: the ledger is
    memberId-without-FK by design, late captures on cancelled bookings
    still refund through the orphan path, and subscription webhooks from
    the pipeline's own cancel resolve via the kept stripeCustomerId. The
    one guard added: payment_method.attached racing the closure does not
    resurrect a mirror row for a deleted member.

## Post-review hardening (2026-08-11)

29. **A completed deletion request sheds its PII.** deletion_requests
    keeps the row for provenance (decision 21), but emailAtRequest exists
    solely for the erase_credentials step (magic links key on email) and
    ip for request provenance; the finalize transaction scrubs both
    (email to '', ip to null), so the retained row of an erased account
    carries no plaintext email or IP the tombstones scrubbed everywhere
    else. memberNumberAtRequest and timestamps remain the human-readable
    provenance. Blocked/failed rows keep the email — a later resume still
    needs it to burn magic-link tokens.

30. **cancelSubscriptionNow is idempotent at the gateway.** Its callers
    gate on the LOCAL membership status, which flips only when the
    customer.subscription.deleted webhook lands; a retry inside that lag
    window (deletion-pipeline resume, crash re-run) legitimately
    re-cancels an already-terminal subscription. The gateway answers the
    live snapshot instead of surfacing Stripe's 400 (mirroring
    releaseSchedule's already-terminal handling); genuinely non-terminal
    errors still throw.

## Structure

27. **The account BC owns ONLY the deletion saga** (deletion_requests +
    ports); it is imported by nothing but the transport layer. Profile,
    QR and ID verification live in members; preferences and devices in
    communications; stats in bookings; step-up and erasure in identity.
    A deletion service inside identity would invert the dependency
    direction (identity is the graph's base); a grab-bag account context
    would become a second members.
28. **Media generalization** (prerequisite): the event-image pipeline
    became a usage registry (event-image | avatar | id-photo) with
    per-usage validation, normalization, visibility, cache policy,
    encryption and pending-TTL; path scheme public `/uploads/<dir>/<name>`
    vs private `private/<dir>/<name>` (no leading slash: never routable);
    strict whitelist parsing (registry directory + cuid name) kills
    traversal; consumer BCs ride usage-PINNED adapters so an event-image
    call can never re-own or delete an avatar or ID photo; the cleanup
    sweeper's owner-reference registry is enforced by the compiler
    (`satisfies Record<MediaUsage, ...>`). AES-GCM moved to the kernel
    with byte framing; the default purpose label keeps existing Apple
    refresh tokens decryptable.
