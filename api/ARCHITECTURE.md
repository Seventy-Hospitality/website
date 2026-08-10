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
│   │   ├── domain/               # Membership types, webhook handlers (pure)
│   │   ├── application/          # Checkout, portal, sync services
│   │   └── infrastructure/       # Stripe gateway, repositories
│   ├── identity/
│   │   ├── domain/               # Principal, session/linking policies, token logic
│   │   ├── application/          # Authentication, sessions, account linking
│   │   └── infrastructure/       # Repos, argon2, JWT, Google/Apple verifiers
│   ├── bookings/                 # Scheduling/reservations BC (see below)
│   │   ├── domain/               # Slot math, tiers, participant machine, refund policy
│   │   ├── application/          # ReservationService, ResourceClaimService
│   │   └── infrastructure/       # Repositories, stub payment adapter (package C seam)
│   ├── events/                   # Club events; claims courts via ResourceClaimPort
│   └── communications/
│       ├── domain/               # Email templates (pure data)
│       ├── application/          # NotificationService (what to send)
│       └── infrastructure/       # EmailAdapter (Resend)
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

- Repositories (Prisma-backed or event-sourced)
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
   `FOR UPDATE SKIP LOCKED`, hands them to an `OutboxSink` and marks them
   dispatched in one transaction. The sink is a no-op until notifications
   land (package F).

Never use seq-cursor checkpoints for consumers: `seq` is assigned at insert
but transactions commit out of order, so a cursor past N+1 can permanently
skip N. Undispatched-row selection has no gap hazard and lets concurrent
dispatchers share the backlog.

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
  (`/api/cron/expire-holds`) checks the intent before expiring a hold.
- **Per-member daily limit**: cross-aggregate, so the booking transaction
  takes `pg_advisory_xact_lock(hashtext(memberId))` before counting.
- **Time model**: UTC instants (`timestamptz`) + one venue IANA zone
  (`VENUE_TIMEZONE`); wall-clock math lives in `lib/kernel/venue-time.ts`.
  A range counts against the local date of its start.
- **Events BC** claims courts exclusively through `ResourceClaimPort`; it
  never writes `slot_claims` directly.

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

## Webhook Processing

Stripe webhooks arrive at `/api/webhooks/stripe`:

1. Verify signature
2. Process event inline by calling domain-layer handlers
3. Handlers update aggregate state via repositories
4. Return 200 even on failure — Stripe retries on non-2xx

## Scheduled Tasks

Scheduled maintenance should be platform-neutral:

- the API exposes authenticated cron routes under `/api/cron/*` for schedulers that trigger URLs
- standalone job entrypoints can be run directly from whatever scheduler hosts the app

The stale event-image cleanup job is exposed both ways:

- HTTP: `POST /api/cron/cleanup-event-images`
- CLI: `npm run job:cleanup-event-images`

Scheduling crons (HTTP only):

- `POST /api/cron/expire-holds` — release stale pending_payment holds
  (confirming instead when the payment actually succeeded)
- `POST /api/cron/dispatch-outbox` — hand undispatched audit rows to the
  outbox sink (a no-op until package F wires notifications)
