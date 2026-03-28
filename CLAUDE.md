# CLAUDE.md

Quick reference for AI assistants working in this codebase.

## What This Is

**Seventy** — Member management system for the Seventy Badminton Club. Single-location, ~100-200 members. Manages member profiles, Stripe-based recurring memberships, and admin operations.

## Monorepo Layout

```
seventy/
├── api/             # Fastify REST API (TypeScript, Prisma, DDD)
├── web/             # React SPA (Vite, React Router, Octahedron)
└── signature/       # Email signature (separate, unrelated)
```

## Stack

- **API:** Fastify, TypeScript, Prisma ORM, PostgreSQL (Cloud SQL)
- **Web:** React 19, Vite, React Router, Octahedron design system (CSS Modules + tokens)
- **Billing:** Stripe (subscriptions, checkout, customer portal)
- **Email:** Resend (transactional email via communications BC)
- **Auth:** Custom magic-link + JWT (no Clerk, no third-party auth)
- **Hosting:** Google Cloud Run (API + Web), Cloud SQL (Postgres)

## Architecture

DDD monolith ported from arciops patterns. See `api/ARCHITECTURE.md` for full details.

### API Structure (`api/`)

```
api/
├── src/
│   ├── server.ts            # Fastify entry point
│   ├── middleware/           # Auth hook
│   ├── routes/              # Transport layer (thin Fastify routes)
│   └── lib/                 # Response helpers, validation schemas
├── lib/
│   ├── kernel/              # Shared kernel (DDD primitives)
│   ├── infrastructure/      # Prisma, event store, UoW
│   ├── contexts/            # Bounded contexts
│   │   ├── members/         # Member CRUD + admin notes
│   │   ├── memberships/     # Stripe subscriptions, checkout, portal
│   │   ├── auth/            # Magic-link, JWT, sessions
│   │   └── communications/  # Email templates, notification delivery
│   ├── container.ts         # Composition root
│   └── db.ts                # Prisma singleton
└── prisma/                  # Schema + migrations + seed
```

### Web Structure (`web/`)

```
web/
├── src/
│   ├── App.tsx              # React Router routes
│   ├── pages/               # Route components
│   ├── components/          # UI components (Octahedron-based)
│   ├── lib/api.ts           # API client
│   └── styles/              # Design tokens
```

### Layer Rules

1. **Domain** (`lib/contexts/*/domain/`) — pure business logic, NO framework imports
2. **Application** (`lib/contexts/*/application/`) — orchestration, NO direct Prisma
3. **Infrastructure** (`lib/contexts/*/infrastructure/`) — Prisma, Stripe SDK, Resend
4. **Transport** (`src/routes/`) — thin Fastify route wrappers

## Key Design Decisions

- **Stripe is source of truth** for billing. Local DB is a projection.
- **Webhooks processed inline** (Stripe retries on failure).
- **No NestJS** — vanilla TypeScript with composition root for DI.
- **No Tailwind** — Octahedron design system.
- **Communications BC** owns all outbound email. Other BCs call NotificationService.

## Essential Commands

```bash
# API
cd api && npm run dev            # Start API (http://localhost:3001)
cd api && npm run db:migrate     # Run Prisma migrations
cd api && npm run db:seed        # Seed test data
cd api && npm run test           # Run tests
cd api && npm run db:studio      # Prisma Studio

# Web
cd web && npm run dev            # Start web (http://localhost:5173)

# Stripe
stripe listen --forward-to localhost:3001/api/webhooks/stripe
```

## Related Docs

| Document | Location | Purpose |
|----------|----------|---------|
| `api/ARCHITECTURE.md` | API | DDD architecture, layer rules, event sourcing |
| `api/DESIGN_SYSTEM.md` | API | UI tokens, typography, spacing, component usage |
