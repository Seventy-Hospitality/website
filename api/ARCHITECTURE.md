# Architecture

DDD architecture for Seventy, ported from the arciops NestJS codebase. Same patterns, no framework coupling.

## Core Principle: Strict Layer Separation

Domain code has ZERO framework dependencies. No Next.js, no Prisma, no Stripe imports in domain files. Infrastructure concerns are injected through abstract interfaces.

## Directory Structure

```
lib/
├── kernel/                       # Shared kernel — DDD primitives (zero deps)
│   ├── aggregate-root.ts         # AggregateRoot<TState, TEvent> base class
│   ├── aggregate-repository.ts   # Abstract repository contract
│   ├── domain-event.ts           # DomainEvent<TType, TData> interface
│   ├── replay-event-record.ts    # Event replay types
│   ├── unit-of-work.ts           # Abstract UoW + opaque TransactionContext
│   ├── version-conflict-error.ts # Optimistic concurrency error
│   ├── retry-on-conflict.ts      # Retry utility
│   └── index.ts                  # Barrel export
├── infrastructure/               # Concrete implementations (Prisma, etc.)
│   ├── prisma-tx.ts              # Opaque TX ↔ Prisma TX conversion
│   ├── prisma-unit-of-work.ts    # Concrete UoW backed by Prisma
│   ├── event-store.ts            # Append events to Event table
│   ├── event-replay.ts           # Replay events through reducers
│   ├── event-sourced-repository.ts # Load/save aggregates via events
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
│   ├── auth/
│   │   ├── domain/               # Session, auth types, token logic
│   │   ├── application/          # Auth service (magic link, JWT)
│   │   └── infrastructure/       # JWT, session repo
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

## Event Sourcing

### Event Store

All domain mutations are recorded as events in the `events` table:

```
Event { seq, streamType, streamId, eventType, data, occurredAt, recordedAt }
```

### Aggregate Lifecycle

1. **Load**: Repository fetches events for stream → replays through reducer → returns hydrated aggregate
2. **Mutate**: Application service calls domain methods → aggregate applies events internally
3. **Save**: Repository appends uncommitted events to event store within transaction
4. **Concurrency**: Version check (last seq) prevents lost updates

### Reducers

Pure functions that fold events into state. Must handle both legacy and new event types for backwards compatibility:

```typescript
function memberReducer(state: Member, event: ReplayEventRecord): Member {
  switch (event.eventType) {
    case 'MemberCreated':
      return { ...state, ...event.data as MemberCreatedData };
    case 'MemberUpdated':
      return { ...state, ...event.data as MemberUpdatedData };
    default:
      return state;
  }
}
```

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

Magic-link + JWT sessions, same as arciops but without NestJS guards. Next.js middleware handles the guard role:

1. `POST /api/auth/magic-link` → generate token, send email
2. `GET /api/auth/verify?token=...` → validate, create session, return JWT
3. All subsequent requests: JWT in cookie or Authorization header
4. `middleware.ts` validates JWT, attaches user to request context

## Webhook Processing

Stripe webhooks arrive at `/api/webhooks/stripe`:

1. Verify signature
2. Process event inline by calling domain-layer handlers
3. Handlers update aggregate state via repositories
4. Return 200 even on failure — Stripe retries on non-2xx

## Scheduled Tasks

Vercel Cron runs weekly membership sync (`/api/cron/sync-memberships`) to reconcile local DB with Stripe. Configured in `vercel.json`.
