# Architecture

DDD architecture for Seventy, ported from the arciops NestJS codebase. Same patterns, no framework coupling.

## Core Principle: Strict Layer Separation

Domain code has ZERO framework dependencies. No Next.js, no Prisma, no Stripe imports in domain files. Infrastructure concerns are injected through abstract interfaces.

## Directory Structure

```
lib/
├── kernel/                       # Shared kernel — DDD primitives (zero deps)
│   ├── unit-of-work.ts           # Abstract UoW + opaque TransactionContext
│   ├── venue-time.ts             # Venue wall-clock <-> instant math (one IANA zone)
│   └── index.ts                  # Barrel export
├── infrastructure/               # Concrete implementations (Prisma, etc.)
│   ├── prisma-tx.ts              # Opaque TX ↔ Prisma TX conversion
│   ├── prisma-unit-of-work.ts    # Concrete UoW backed by Prisma
│   ├── event-store.ts            # Same-transaction audit log appends
│   ├── outbox.ts                 # Outbox dispatcher over the audit log
│   └── index.ts
├── contexts/                     # Bounded contexts
│   ├── members/
│   │   ├── index.ts              # Public barrel (only import from here cross-BC)
│   │   ├── domain/
│   │   │   ├── member.ts         # Member invariants, types, errors
│   │   │   └── index.ts          # Domain barrel
│   │   ├── application/
│   │   │   ├── member.service.ts # Use-case orchestration
│   │   │   └── index.ts
│   │   └── infrastructure/
│   │       ├── member.repository.ts
│   │       └── index.ts
│   ├── memberships/
│   │   ├── domain/               # Membership state, current-row pick, apply resolvers (pure)
│   │   ├── application/          # Subscribe/confirm/change/cancel, SubscriptionGateway port
│   │   └── infrastructure/       # Repositories (guarded snapshot apply)
│   ├── billing/                  # Stripe gateway, money ledger, webhooks (see below)
│   │   ├── domain/               # Ledger math, event refs, pure resolvers
│   │   ├── application/          # Webhook/billing/payment/reconciliation services
│   │   └── infrastructure/       # Stripe SDK (ONLY here), ledger + mirror repos, booking adapter
│   ├── identity/
│   │   ├── domain/               # Principal, session/linking policies, token logic
│   │   ├── application/          # Authentication, sessions, account linking
│   │   └── infrastructure/       # Repos, argon2, JWT, Google/Apple verifiers
│   ├── bookings/                 # Scheduling/reservations BC (see below)
│   │   ├── domain/               # Slot math, tiers, participant machine, refund policy
│   │   ├── application/          # ReservationService, ResourceClaimService
│   │   └── infrastructure/       # Repositories, dev stub payment adapter (keyless local only)
│   ├── events/                   # Club events; claims courts via ResourceClaimPort
│   ├── clubs/                    # Member-created social clubs (see below)
│   │   ├── domain/               # Role matrix, invitation machine, link validity (pure)
│   │   ├── application/          # ClubService (authz, invites, links, deletion seam)
│   │   └── infrastructure/       # ClubRepository, ClubRosterAdapter (bookings port)
│   ├── media/                    # Managed images: usage registry, public/private storage
│   │   ├── domain/               # Usage specs, path scheme (public vs private), validation
│   │   ├── application/          # MediaService (upload/normalize/encrypt/serve/cleanup)
│   │   └── infrastructure/       # Local + S3 object storage, sharp processor, asset repo
│   ├── account/                  # Account-deletion saga ONLY (see decisions-account.md)
│   │   ├── domain/               # Step list, backoff, steps-map (pure)
│   │   ├── application/          # AccountDeletionService + ports into the other BCs
│   │   └── infrastructure/       # deletion_requests repository (lease, step progress)
│   ├── home/                     # Home-screen READ composition (no tables; see below)
│   │   ├── domain/               # Greeting + quick-book heuristics (pure)
│   │   └── application/          # HomeService + ports into bookings/clubs/events/members
│   └── communications/
│       ├── domain/               # Templates (pure data), prefs, devices, notification-decision matrix
│       ├── application/          # NotificationService, settings, outbox dispatch, booking reminders
│       └── infrastructure/       # Resend + Expo push adapters, prefs/devices/ledger repositories
├── container.ts                  # Composition root
├── db.ts                         # Prisma singleton
├── auth.ts                       # Transport: cookies/headers → IAM
├── api-response.ts               # Transport: JSON response helpers
└── validation.ts                 # Transport: Zod schemas for API input
```

## Layer Rules

### Domain Layer (`lib/contexts/*/domain/`)

**Pure business logic. No imports from:**
- `@prisma/client`
- `next/*` or `next/server`
- `stripe`
- Any infrastructure library

**Allowed imports:**
- `@/lib/kernel/*` (shared kernel — DDD primitives)
- Other domain files within same BC
- Standard library / pure npm packages (zod for validation is OK)

### Application Layer (`lib/contexts/*/application/`)

**Use-case orchestration. Coordinates domain + repositories.**

- Receives abstract `UnitOfWork` and `Repository` instances
- Does NOT import Prisma directly — uses repositories
- Does NOT import framework-specific code
- Thin — delegates to domain layer for business rules

### Infrastructure Layer (`lib/contexts/*/infrastructure/`)

**Concrete implementations of abstract interfaces.**

- Repositories (Prisma-backed)
- External service clients (Stripe, Resend)
- This is the ONLY place Prisma, Stripe SDK, etc. are imported

### Transport Layer (`app/api/*/route.ts`)

**HTTP endpoints. Thin wrappers around application services.**

- Validates input (Zod)
- Authenticates request
- Calls application service
- Formats response
- No business logic here

## Cross-BC Import Rules

Cross-bounded-context imports MUST go through barrel exports:

```typescript
// ✅ Correct — import from BC barrel
import { MemberService } from '@/lib/contexts/members';

// ✅ Correct — import domain types from domain barrel
import type { Member } from '@/lib/contexts/members/domain';

// ❌ Forbidden — reaching into internal files
import { MemberService } from '@/lib/contexts/members/application/member.service';
```

Allowed import paths from outside a BC:
- `@/lib/contexts/{bc}` (main barrel)
- `@/contexts/{bc}/domain` (domain types only)

## Audit Log + Transactional Outbox (not event sourcing)

Relational state is the source of truth; aggregates are NOT event-sourced.
The `events` table serves two purposes:

```
Event { seq, streamType, streamId, eventType, data, occurredAt, recordedAt, actorId, dispatchedAt }
```

1. **Audit log**: every domain mutation appends its `reservation.*` /
   identity events via `EventStore.append` INSIDE the same transaction as the
   mutation, with the acting principal as `actorId`. This yields a complete
   history feed (and the raw material for the quick-book heuristic) without a
   second write model.
2. **Transactional outbox**: rows with `dispatchedAt IS NULL` are pending.
   The dispatcher (`lib/infrastructure/outbox.ts`, exposed as
   `POST /api/cron/dispatch-outbox`) selects them with
   `FOR UPDATE SKIP LOCKED`, hands them to the `OutboxSink` and marks the
   DELIVERED ones dispatched in the same transaction; events the sink
   reports failed stay pending and retry. The sink is the communications
   context's notification dispatcher (see Notifications below).

Never use seq-cursor checkpoints for consumers: `seq` is assigned at insert
but transactions commit out of order, so a cursor past N+1 can permanently
skip N. Undispatched-row selection has no gap hazard and lets concurrent
dispatchers share the backlog.

## Notifications (outbox consumer, package F)

The communications BC owns delivery end to end:

- **Decision is pure domain** (`notification-decision.ts`): each outbox
  event type maps to recipient references (literal member ids, or "the
  reservation's organizer" / "the club invitation's inviter" resolved
  later) and per-kind channels. Unmapped events notify nobody. The full
  matrix lives in `docs/decisions-notifications.md`.
- **Dispatch is application** (`NotificationDispatchService`, wired as the
  outbox sink): resolves references through narrow container-wired read
  ports over the members/bookings/clubs barrels, gates channels through
  the member's push/email/bookingReminders toggles plus registered
  devices, and renders email (Resend) and push (Expo-style adapter,
  config-gated on `EXPO_PUSH_ACCESS_TOKEN` exactly as Resend degrades
  keyless). Staff alerts (disputes, failed refunds, blocked deletions) go
  to `STAFF_ALERT_EMAIL` and ignore member preferences.
- **Idempotency = the `delivered_notifications` ledger**: one row per
  (eventSeq, recipient, channel), claimed BEFORE sending and marked sent
  after, auto-committed OUTSIDE the dispatch transaction so redelivery,
  concurrent dispatchers, or a batch that fails halfway never double-send
  while an unfinished claim retries (retry, never drop).
- **Booking reminders** (`/api/cron/send-booking-reminders`, hourly):
  confirmed reservations starting within 24h remind their confirmed
  participants, once per (reservation, member) ever via the
  `booking_reminders` markers.
- **Weekly series** (`/api/cron/materialize-series`): active
  `reservation_series` rows materialize into comp reservations inside the
  type's booking horizon through the normal create path; a blocked
  occurrence is skipped + the organizer notified exactly once (skip
  markers + a partial unique on (seriesId, localDate)), never silently
  shifted. Series creation/cancellation is admin-only
  (`/api/admin/reservation-series`), plan OPEN decision 8.

## Home (read-only aggregation, package F)

`GET /api/me/home` serves the home screen from the `home` context: a
composition-only read service (no tables) with pure greeting/quick-book
domain logic, reaching bookings/clubs/events/members exclusively through
container-wired ports, every read keyed on the principal's member id.
Payload: greeting (first name + time-of-day, client tz honored when
valid), upcoming reservations (viewer participation + `weekly` badge),
pending booking invitations (distinct, inviter first name, inline
accept/decline), pending club invitations, spotlight events, the
deterministic quick-book suggestion (most-frequent type/weekday/time over
90 days of history, availability-verified; fallback most-available
amenity), and the empty-state amenity summary. Heuristic + shape
decisions: `docs/decisions-notifications.md`.

Why not event sourcing: the one invariant that matters (no overlapping
claims) is cross-aggregate and lives in a Postgres exclusion constraint;
every read in the product is an indexed relational query; and per-stream
optimistic concurrency adds nothing on top of the constraint. The former
ES kernel (AggregateRoot, EventSourcedAggregateRepository, EventReplay,
stream_checkpoints) has been deleted; if true ES is ever wanted, the kernel
first needs a per-stream version column with a
`(streamType, streamId, version)` unique.

## Scheduling (reservations)

The bookings BC owns facility scheduling:

- **resource_types** carry ALL policy (slot grid, operating hours as minutes
  from venue-local midnight with the end allowed past 1440, rate, horizon,
  per-member daily limit, cancellation window, `minTier`); **resources** are
  the physical units.
- **slot_claims** is the single physical owner of time on a resource. Member
  reservations and club-event court blocks share ONE DB-enforced no-overlap
  invariant, a btree_gist exclusion constraint (raw SQL migration):
  `EXCLUDE USING gist ("resourceId" WITH =, tstzrange("startsAt","endsAt",'[)') WITH &&) WHERE (status = 'active')`.
  The repositories map a lost race (SQLSTATE 23P01/40P01) to
  `SlotUnavailableError`; UPDATEs are checked against other rows only, which
  gives reschedules self-exclusion for free.
- **Checkout**: no hold during slot-select/invite. Confirm & pay inserts the
  reservation as `pending_payment` plus its active claim with a ~12-minute
  TTL in one transaction (retrying the next candidate resource on a lost
  race), then creates the PaymentIntent OUTSIDE the transaction through
  `BookingPaymentPort` (stubbed until package C). The sweeper cron
  (`/api/cron/expire-holds`) checks the intent before expiring a hold, and
  the create/reschedule paths run the same payment-aware sweep over the
  type's resources before computing candidates, so a slot squatted by an
  abandoned hold is reclaimed between sweeper runs (availability reads also
  treat expired-but-unswept holds as free).
- **State transitions are compare-and-set** (`UPDATE ... WHERE status = ...`,
  0 rows = lost the race) and every mutating path on an existing reservation
  additionally takes `pg_advisory_xact_lock(hashtext('reservation:' || id))`:
  a confirm racing a cancel/expiry can never resurrect the loser's state,
  and exactly one of client confirm / webhook / sweeper appends the
  confirmed audit events. `confirm()` is the single "payment succeeded"
  entry point; it also recovers an EXPIRED reservation whose intent
  actually captured (re-acquire the slot via the exclusion constraint, or
  refund in full), and `cancel()` checks the intent before treating
  `pending_payment` as uncaptured.
- **Refunds are reserved before Stripe runs**: the mutating transaction
  re-reads the ledger under the reservation lock, writes PENDING refund
  rows (which consume refundable balance, so concurrent money paths fail
  closed), commits, and only then calls Stripe, marking each row succeeded
  or failed afterwards.
- **Reschedule money**: shrink/equal applies the (self-excluding) claim
  UPDATE immediately and reserves the refund in the same transaction. A
  GROW never moves the claim before the delta is captured: the delta intent
  is created first, the requested range is parked in
  `reservation_pending_changes` with a TTL, and `confirm()`/the sweeper
  applies the move once the intent succeeds (refunding the delta if the
  target range was taken meanwhile). An unpaid change lapses harmlessly.
- **Per-member daily limit**: cross-aggregate, so the booking transaction
  takes `pg_advisory_xact_lock(hashtext(memberId))` before counting (member
  lock always BEFORE the reservation lock when both are held).
- **Time model**: UTC instants (`timestamptz`) + one venue IANA zone
  (`VENUE_TIMEZONE`); wall-clock math lives in `lib/kernel/venue-time.ts`.
  A range counts against the local date of its start. Clients read the
  zone from `GET /api/venue` (public; the single source) and must anchor
  date strips and "today" on it, never on the device zone.
- **Availability self-exclusion**: `GET /api/resource-types/:code/availability`
  accepts `excludeReservationId` so the edit flow sees its own claims as
  free; the service releases it only to a participant of that reservation
  (404-shaped otherwise, no id probing).
- **Payment-intent reissue**: `POST /api/reservations/:id/payment-intent`
  (organizer) replaces a failed/consumed secret for the hold charge while
  `pending_payment` with a live hold, or for a live parked change delta —
  same hold, same TTL, next `attempt` under the per-attempt idempotency
  keys. Money is never superseded: the previous intent is retired at
  Stripe BEFORE the replacement exists, a captured one settles through
  confirm() and answers `alreadyPaid`, and a cancel failure that is not a
  capture aborts the reissue (fail closed).
- **Events BC** claims courts exclusively through `ResourceClaimPort`; it
  never writes `slot_claims` directly.

## Clubs (member-created social clubs)

The clubs BC owns Club, ClubMember, ClubInvitation and ClubInviteLink.
These are the members' own groups, not the facility's events.

- **Single-owner model**, enforced in the service under a per-club advisory
  lock with pure domain rules: promoting another member transfers ownership
  (actor demoted in the same transaction); the owner cannot demote
  themselves, be removed, or leave without transferring. Route policy is
  `member` everywhere; club-level authorization is re-derived per request:
  outsiders get 404 on any club id (no probing), members get 403 on
  owner-only actions.
- **Invitations require acceptance** (no direct-add): a pending
  `club_invitations` row per (club, invitee), enforced by a partial unique
  index (raw SQL); history rows (declined/revoked/accepted) accumulate and
  a re-invite is a new row.
- **Invite links/QR**: tokens sha256-hashed at rest (identity token
  pattern), raw value returned exactly once. Members mint; `rotate` revokes
  all previous links and is owner-only. Join is idempotent (an existing
  member never 410s) and the consuming UPDATE re-checks
  revocation/expiry/maxUses so races cannot overshoot a use limit.
- **Bookings seam**: a court booking can invite a whole club. Bookings
  reaches club membership ONLY through `ClubRosterPort`
  (bookings/domain/ports.ts), implemented by the clubs context and wired in
  the container. Expansion snapshots the CURRENT roster at invite time into
  pending `reservation_participants` with `viaClubId` provenance; the
  inviter must belong to every club named. `reservations.clubId` (first
  club chip) feeds `GET /api/clubs/:id/activity`; both linkage columns are
  FKs with SET NULL on club deletion.
- **Covers** ride the media context's ManagedMediaAsset pipeline (event
  image pattern, `ownerType: 'club'`).
- **Account deletion seam (package E)**:
  `clubService.releaseMemberForAccountDeletion` transfers owned clubs to
  the longest-tenured remaining member (tie: member id), deletes empty
  clubs, removes memberships, withdraws pending invitations both ways and
  revokes share links the member minted.
- All mutations append `club.*` audit/outbox events in-transaction
  (package F consumes them). Decisions: `docs/decisions-clubs.md`.

## Media (managed images)

One usage-parameterized pipeline (`lib/contexts/media`): a domain registry
(`event-image | avatar | id-photo`) carries each usage's directory,
visibility, mime/size limits, sharp normalization, cache policy, at-rest
encryption and pending TTL. Path invariant: public assets live at
`/uploads/<dir>/<name>` (the storage path IS the URL, served by the public
uploads route); private assets use a bare `private/<dir>/<name>` key no
route can serve, reachable only through their authenticated endpoint.
`parseAssetPath` is a strict whitelist (registry directory + cuid object
name), so traversal and prefix confusion are structurally dead. Private
usages are encrypted in the application layer (AES-256-GCM, kernel cipher,
`MEDIA_ENCRYPTION_KEY`, buffered and tag-verified before a byte is
served). Uploads are `pending` until attached to an owner; the cleanup
cron sweeps per-usage TTLs behind a compiler-enforced owner-reference
registry, and deletes are discard -> object delete -> `purgedAt` (the
retention proof), with a retry sweep for unconfirmed purges. Consumer BCs
(club covers, event images, avatars, ID photos) go through usage-PINNED
adapters wired in the container: a call wired for one usage can never
attach or delete an asset of another.

## Account surface (package E)

- **Member number**: stable human-facing id (`#` + one uppercase letter,
  I/O excluded, + five digits), random, generated at member creation,
  unique forever (deletion keeps it on the anonymized row). Directory
  search matches it by prefix; rosters carry it. Never an auth identifier.
- **Profile**: displayName (member-chosen, distinct from legal names),
  avatarUrl (media pipeline, public `avatar` usage), memberSince, and
  lifetime activity stats computed in the bookings read side (confirmed
  reservations as organizer; badminton_court/tennis_court families only;
  hours = scheduled duration sums). `docs/decisions-account.md` has the
  exact definition.
- **Member QR**: `GET /api/me/qr` issues a 60-second HMAC token
  (`MQR1.<payload>.<sig>`, dedicated key derivation), never the raw member
  id; `POST /api/qr/verify` (staff) checks signature+expiry and re-reads
  the member row, so deleted members scan as invalid.
- **Notification preferences + push devices** live in the communications
  BC (package F's consumers read them). Toggle upserts carry only the keys
  present; devices are keyed on the globally-unique push token.
- **ID verification** lives in the members BC: one row per member, pure
  state machine (upload/replace until submitted or after rejection,
  CAS-guarded staff review), photo in PRIVATE encrypted storage, deleted
  on review decision and account deletion, served solely through the
  audited staff endpoint.
- **Account deletion** is the `account` BC: a resumable saga over
  `deletion_requests` consuming billing/bookings/clubs/identity/members/
  communications through container-wired ports. DELETE /api/me (policy
  `authenticated`) requires step-up proof (password, subject-bound OAuth
  assertion, or a session-bound emailed `reauth` token); creation
  quiesces (freeze-stamp + revoke other sessions + kill devices; the auth
  ladder answers 409 for every policy above `authenticated`), then the
  ordered idempotent steps run with per-step progress, exponential
  backoff, a worker lease, and a finalize step that commits the
  `account.deleted` outbox event atomically with completion.
  `/api/cron/resume-deletions` re-drives incomplete requests once the
  user's credentials are gone. Full sequence + rationale:
  `docs/decisions-account.md`.

## Dependency Wiring

Without NestJS DI, we use a simple composition root pattern:

```typescript
// lib/container.ts — single place where concrete deps are wired
import { db } from './db';
import { PrismaUnitOfWork } from './infrastructure';
import { EventStore, EventReplay } from './infrastructure';

export const uow = new PrismaUnitOfWork(db);
export const eventStore = new EventStore();
export const eventReplay = new EventReplay(db);

// Context-specific wiring
export { memberService } from '@/lib/contexts/members';
```

## Transaction Boundaries

All writes go through `UnitOfWork.execute()`:

```typescript
async function acceptMember(memberId: string) {
  await uow.execute(async (tx) => {
    const member = await memberRepo.load(memberId);
    member.accept();
    await memberRepo.save(tx, member);
  });
}
```

The `TransactionContext` type is opaque — application code cannot access Prisma through it. Only infrastructure code (repositories) can unwrap it via `asPrismaTx()`.

## Auth Pattern

The `identity` context owns users, credentials, federated identities, rotating
sessions and one-time tokens. Authentication mints a session; authorization is
a per-route policy enforced by two Fastify hooks in `src/middleware/auth.ts`.

### Sessions

- Access token: 10-minute JWT carrying `sub`, `sid`, `typ` only. No role claim
  ever: roles and the member link are read from the database per request, so
  revocation and staff changes take effect immediately.
- Refresh token: 32 random bytes, stored sha256-hashed, rotated on every use
  with a 60s grace window; presenting a rotated-away token outside the grace
  revokes the whole session (theft signal).
- Mobile carries both tokens itself; the admin web rides httpOnly cookies and
  the auth hook rotates them transparently, so the browser never sees the
  10-minute access TTL.

### Policy ladder

Every route declares exactly one policy in its `config`:

| Policy | Passes when |
|---|---|
| `public` | always |
| `authenticated` | any valid session |
| `member` | session + `principal.memberId != null` |
| `active-member` | member + membership status `active` |
| `staff` | `staffRole` is `staff` or `admin` |
| `admin` | `staffRole` is `admin` |
| `cron` | `Authorization: Bearer $CRON_SECRET` |
| `webhook` | always; the route verifies the provider signature |

```typescript
app.get('/profile', { config: { policy: 'member' } }, async (req, reply) => {
  const member = await memberService.getById(req.principal!.memberId!);
  return success(reply, member);
});
```

Entitlements finer than "membership is active" (PRO tier, per-type limits) are
data, not policies: they are read in the domain that enforces them. Resource
ownership ("this booking is mine") also stays in the services.

### Boot assertion

`assertRoutePolicy` is registered as an `onRoute` hook before the first route,
and throws if a route declares no policy. Forgetting to annotate a new route
crashes startup instead of quietly serving it: there is no default policy and
no URL allowlist (`PUBLIC_PREFIXES` is gone). The one exemption is
`@fastify/static`, which generates a route per file of the bundled web app and
cannot declare config; those routes are stamped `public`.

### Principal

`authHook` (a `preHandler`) enforces the declared policy and attaches
`req.principal`:

```typescript
interface Principal {
  userId: string; sessionId: string; email: string; emailVerified: boolean;
  staffRole: 'staff' | 'admin' | null;   // from the DB, never from the token
  memberId: string | null;               // the club profile, if any
  client: 'admin_web' | 'member_mobile';
}
```

`AUTH_DISABLED=true` (non-production only, asserted at import) injects a
complete development principal so any policy can be exercised locally; cron
still requires its secret.

## Billing

The billing BC owns the Stripe gateway (SDK imports live ONLY in
`billing/infrastructure`), the member-facing money ledger, the
payment-method mirror and webhook processing. The other contexts reach it
through narrow seams:

- **memberships** owns subscription STATE and lifecycle decisions
  (subscribe/confirm/change/cancel) behind its `SubscriptionGateway` port,
  which billing's `StripeGateway` implements. Purchase is
  subscription-first (`default_incomplete`,
  `save_default_payment_method: on_subscription`,
  `latest_invoice.confirmation_secret` to PaymentSheet); the confirm
  endpoint does a synchronous read-back through the same idempotent apply
  path as the webhook. One membership row per Stripe subscription
  (memberId is NOT unique); "the member's current membership" is
  `pickCurrentMembership`. Upgrades change price immediately with
  prorations; downgrades ride a transient subscription schedule to period
  end, no refund.
- **bookings** charges through `BookingPaymentPort`, implemented by
  `StripeBookingPaymentAdapter`: on-session PaymentIntents
  (`allow_redirects: 'never'`), server-authoritative amounts, idempotency
  key per reservation attempt, refunds keyed by the reserved settlement row
  id. `payment_intent.succeeded` and the reconcile cron settle through
  `reservationService.handleCapturedPayment`, which also repairs the
  pay-vs-drop TOCTOU (a capture landing after cancel) at the persisted
  cancellation refund percent.
- **billing_transactions** is the append-only member-facing ledger: one row
  per Stripe money movement, upserted on
  `[stripeObjectType, stripeObjectId]` by the webhook service, the refund
  adapter's best-effort observations and the nightly reconcile sweep, all
  converging on the same rows. `occurredAt` is Stripe's `created`; month
  buckets group in the venue timezone. Billing reads NEVER fan out to
  Stripe. `reservation_payments` stays the bookings-side settlement record
  (refund allocation, state machine); the shared allocation math lives once
  in `lib/kernel/payment-allocation.ts`.

## Webhook Processing

Stripe webhooks arrive at `/api/webhooks/stripe`:

1. Verify signature (thin route), map to a plain event ref
2. `WebhookService.process`: skip if the event id was already processed
3. Subscription-shaped events are TRIGGERS: re-fetch the subscription and
   apply fresh state under a fetch-time ordering guard (no exit from
   `canceled`), so out-of-order deliveries can never move state backwards
   or resurrect a canceled membership
4. Money events upsert ledger rows and drive bookings settlement; refund
   and dispute events reconcile/freeze the bookings settlement record
5. Record the event id, answer 200. A transient failure answers **500** so
   Stripe retries (handlers are idempotent); only permanently unhandleable
   states (unknown price, unresolvable member) are alerted and acknowledged

## Scheduled Tasks

Scheduled maintenance should be platform-neutral:

- the API exposes authenticated cron routes under `/api/cron/*` for schedulers that trigger URLs
- standalone job entrypoints can be run directly from whatever scheduler hosts the app

The stale event-image cleanup job is exposed both ways:

- HTTP: `POST /api/cron/cleanup-event-images`
- CLI: `npm run job:cleanup-event-images`

Scheduling and billing crons (HTTP; every cron route answers GET as well as
POST because URL-triggering schedulers issue GETs — the secret, not the
verb, is the guard):

- `/api/cron/expire-holds` — release stale pending_payment holds
  (confirming instead when the payment actually succeeded)
- `/api/cron/dispatch-outbox` — hand undispatched audit rows to the
  notification dispatcher; failed deliveries stay pending and retry
- `/api/cron/send-booking-reminders`: remind confirmed participants of
  reservations starting within 24h (once per reservation+member ever)
- `/api/cron/materialize-series`: weekly series to concrete comp
  reservations inside the horizon (skip + notify once on collision)
- `/api/cron/reconcile-billing` — nightly account-wide sweep of the last
  72h of charges, paid invoices and refunds into the ledger; re-drives
  bookings settlement (closes webhook gaps and the cancel-vs-pay TOCTOU);
  prunes old webhook-dedupe rows
- `/api/cron/subscription-drift` — account-wide subscription listing
  applied through the same guarded path as webhooks (replaces the old
  per-member syncFromStripe loop)
- `/api/cron/resume-deletions` — re-drives incomplete account-deletion
  sagas (after credential erasure the user cannot retry themselves)

One-time job: `npm run job:backfill-billing-ledger` imports historical
Stripe charges/invoices/refunds into the ledger (ledger-only, idempotent).
