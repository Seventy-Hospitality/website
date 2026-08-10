# Club70 App: API plan

Source of truth for the member-app backend build. Derived from the Figma
("Club70-App", file `YApcPUsyLEwwv58uioog8h`, page `0:1`, sections: onboarding `26:637`,
booking `26:630`, accepting `225:3691`, editing `152:12072`, clubs `105:7056`,
account `107:7467`), the current codebase, and three independent architecture
critiques (identity, scheduling domain, payments). Decisions below are settled
unless marked OPEN.

## 0. Canonical tree (decided 2026-08-10)

`Seventy-Hospitality/api` (standalone) and `website/api` (inside the `website`
monorepo) were forks of the same codebase. **The monorepo is canonical**: it is
ahead on identity (unified `User` model, `Session.userId` FK, `Member.userId`,
`/api/admin/users`) and owns CI + ECR/App Runner deploy. Verified during
reconciliation: every standalone-only fix (Stripe customer-ID persistence,
webhook retry 500s, JWT spec fix) is already present here byte-identical, so
nothing needed forward-porting. The standalone repo should be archived; do not
commit to it.

## 1. Settled architecture decisions

### Identity (build, don't buy)
- One `users` table for all humans. `staffRole String?` (`null | staff | admin`)
  replaces the meaningless `role` default. `Member` stays a separate domain
  table linked by `Member.userId`; staff never appear in the member directory.
- Credentials in separate tables so they can't leak through raw-row
  serialization: `user_credentials` (argon2id PHC strings via `@node-rs/argon2`),
  `auth_identities` (`@@unique([provider, subject])`, Apple refresh token stored
  encrypted for `/auth/revoke`), `auth_sessions` (per-device, hashed rotating
  refresh tokens, reuse detection, per-client TTLs: admin web 12h idle/30d,
  mobile 60d idle/180d), `auth_tokens` (all one-time tokens, hashed).
- Native Google/Apple = server-side ID-token verification with nonce binding
  (jose + remote JWKS), not redirect flows. Apple client secret generated
  per call from the .p8 key, never stored. Account-linking rules live in a pure
  `linking-policy.ts` domain function, unit-tested hard (pre-hijack defense:
  provider-verified email + local verified email or proof of ownership).
- Access JWT 10 min, no role claim (roles read from DB per request). Session
  row validated on every request (keeps instant revocation).
- Authorization: delete `PUBLIC_PREFIXES`. Every route declares
  `config.policy` from the ladder `public | authenticated | member |
  active-member | staff | admin | cron | webhook`; an `onRoute` boot hook
  crashes startup if a route has no policy (fail closed). `req.user` becomes
  `req.principal` (`userId, sessionId, email, emailVerified, staffRole,
  memberId, client`). Resource ownership checks stay in services.
- Buy verdict: WorkOS has no native-token grant (would force a browser
  handoff the design doesn't show); Clerk was deliberately removed
  (website/CLAUDE.md); Auth0 lacks native Google. Build; keep the
  `FederatedIdTokenVerifier` port as the future swap seam.

### Scheduling domain (replaces bookings)
- `resource_types` (badminton_court, tennis_court, mahjong_table,
  tennis_simulator, shower) carries all policy: slot duration (30),
  operating hours as minutes-from-venue-midnight (end may exceed 1440),
  `hourlyRateCents`, horizon, per-member daily limit, cancellation window,
  `minTier`. `resources` are the individual courts/tables. Court + Shower
  tables are superseded.
- `slot_claims` is the single physical owner of time on a resource: one row per
  claim, `tstzrange` semantics, kind `reservation | event`, with a Postgres
  **exclusion constraint** (`btree_gist`, raw SQL migration) as the only
  arbiter of no-overlap. Member reservations and club-event court blocks share
  it; ClubEvents claim courts through a `ResourceClaimPort`. This also gives
  reschedules self-exclusion for free (UPDATE checks only other rows).
- `reservations` (supersedes `Booking`): reference (`BK-` + PG sequence),
  resourceTypeId, server-assigned resourceId, organizerId, nullable clubId and
  seriesId, `startsAt/endsAt timestamptz` + derived venue-local `localDate`,
  status `pending_payment | confirmed | cancelled | expired`, rate snapshot,
  amountPaidCents, `createdByAdminId`.
- `reservation_participants`: `@@unique([reservationId, memberId])`, role
  organizer|guest, status `confirmed | pending | declined | withdrawn`,
  invitedById, viaClubId. Organizer starts confirmed. Reschedule resets
  confirmed guests to pending in the same transaction. Declines keep the row.
- `reservation_series` for the Weekly badge: local wall time + weekday,
  materialized into real reservations by cron inside the horizon (skip +
  notify on collision, never shift silently).
- Concurrency/checkout: no hold during slot-select or invite steps. On
  Confirm & pay, one transaction inserts the reservation as `pending_payment`
  plus its claim with `expiresAt = now() + 12min`; exclusion-constraint
  violation (SQLSTATE 23P01) retries the next candidate resource of the type,
  then fails "slot just taken". Payment happens outside the transaction (see
  billing). Sweeper cron expires stale holds but checks PI status first.
  Per-member daily limit guarded with `pg_advisory_xact_lock(hashtext(memberId))`.
- Availability is computed per-resource then unioned; the quote and create
  paths validate that a single resource can host the entire slot set.
- Event sourcing: **not** the mutation path. Relational state is truth. The
  `events` table becomes a same-transaction audit log + transactional outbox
  (undispatched-rows + `FOR UPDATE SKIP LOCKED`, no seq checkpoints) feeding
  notifications and the quick-book heuristic. Delete or quarantine
  `AggregateRoot`/`EventSourcedAggregateRepository`/`EventReplay`/
  `stream_checkpoints`; rewrite ARCHITECTURE.md to match.
- Time model: UTC `timestamptz` everywhere + one venue IANA zone (the
  ClubEvent model, generalized). Kills the midnight-crossing and DST bugs in
  the `date + "HH:MM"` model. A range counts against the local date of its
  start.

### Billing (new bounded context)
- `lib/contexts/billing/` owns the Stripe gateway (moved from memberships,
  API version pinned), ledger, payment-method mirror, webhook processing.
  `memberships` keeps subscription lifecycle behind a narrow port. `bookings`
  reaches billing via a `BookingPaymentPort`.
- Card capture: Stripe PaymentSheet (mobile SDK) everywhere; ephemeral keys
  minted with the mobile SDK's pinned API version. PCI stays SAQ A. No
  redirects, never raw card API.
- Membership purchase: subscription-first (`default_incomplete`,
  `save_default_payment_method: on_subscription`, expand
  `latest_invoice.confirmation_secret`), client secret to PaymentSheet,
  synchronous confirm read-back + idempotent webhook convergence. Terms
  acceptance recorded server-side (users row + subscription metadata).
- Booking charges: on-session PaymentIntent per charge
  (`allow_redirects: 'never'`), server-authoritative amount, idempotency key
  per reservation attempt, PI reused after decline. `reservations
  .paymentIntent` linkage both directions (column + PI metadata).
- Reschedule delta: computed from the local ledger
  (`newTotal - (charges - refunds)` at the snapshot rate). Shrink refunds to
  the card (newest-first allocation across PIs, asserted `<= net paid` in the
  writing transaction, applied optimistically, reconciled via refund
  webhooks). Grow charges a new PI. Disputes freeze the reservation
  financially.
- Ledger: `billing_transactions` (kind, direction debit|credit, positive
  amountCents, taxCents, currency, status, `occurredAt` = Stripe `created`,
  stripe object type+id with `@@unique`, receiptUrl, reservation/membership
  linkage). Month grouping via `date_trunc` in the venue zone. Stripe is
  truth for money movement; the ledger is truth for domain meaning.
  Nightly 72h reconciliation sweep. Backfill once from Stripe.
- Webhooks rewritten: `processed_webhook_events` dedupe, subscription events
  treated as triggers that re-fetch and apply fresh state with a monotonic
  `currentPeriodEnd` guard, 500 on transient failure (the current catch-all
  200 disables Stripe retries and loses events). Add
  `invoice.payment_action_required`, refund and dispute and
  `payment_method.*` events. Dashboard-initiated actions must produce ledger
  rows.
- `payment_methods` mirror table fed by webhooks; "Edit payment method" =
  setup-mode PaymentSheet, then set default on BOTH customer and
  subscription.
- Plan changes: monthly to annual upgrades immediately with prorations;
  downgrades at period end, no refund. Cents everywhere, USD, store currency
  + tax columns anyway (PaymentIntents don't support Stripe Tax; booking tax
  is computed by us if ever needed).
- Account deletion: never `customers.del()`. Resumable `deletion_requests`
  pipeline: step-up re-auth, revoke sessions + Apple `/auth/revoke`, cancel
  subscription, cancel/refund future reservations, detach PMs, soft-delete +
  anonymize Member/User (tombstone email frees the unique index), keep the
  ledger (retention + disputes), tag the Stripe customer.

## 2. Pre-flight bug fixes (exist today, independent of features)

1. Booking overlap check is racy (READ COMMITTED check-then-insert); fixed
   structurally by the exclusion constraint.
2. `getOrCreateUserId` mints phantom author IDs for admin notes (fixed by the
   monorepo's User FK; backfill old rows).
3. `JWT_SECRET` dev fallback must crash prod boot; `AUTH_DISABLED` must assert
   non-prod.
4. Email normalization (lowercase+trim) on write and lookup.
5. No rate limiting: add `@fastify/rate-limit` (auth + search routes first).
6. Webhook catch-all 200 + no dedupe + out-of-order handling (billing
   rewrite).
7. Stripe client has no pinned `apiVersion`.
8. `/api/stripe/*` takes `memberId` from the body with no ownership check:
   IDOR the moment members can authenticate. Member variants derive identity
   from the principal; body-driven routes stay admin-only.
9. `/uploads/*` is world-readable; fine for event images, forbidden for ID
   photos (private, encrypted, short-retention path).
10. Session eviction keyed on email evicts across clients; key on
    userId+client.

## 3. Endpoint map

Envelope: `{ data }` / `{ error: { code, message } }` via `responses.ts`. Zod
per input. Every route declares a policy; `member` = has Member profile,
`active-member` = membership active (PRO gating is data, not a policy).

### Auth (`src/routes/auth.ts`)
| Method | Path | Policy | Purpose |
|---|---|---|---|
| POST | /api/auth/signup | public | Create account (name, email, password, phone); send verification email; return token pair |
| POST | /api/auth/signin | public | Email + password |
| POST | /api/auth/oauth/nonce | public | Single-use nonce for native OAuth |
| POST | /api/auth/oauth/google | public | Verify Google ID token; create/link/sign in |
| POST | /api/auth/oauth/apple | public | Verify Apple identity token; persist first-auth fullName; store refresh token for revoke |
| POST | /api/auth/refresh | public | Rotate refresh token (reuse detection, grace window) |
| POST | /api/auth/signout | authenticated | Revoke current session |
| POST | /api/auth/signout-all | authenticated | Revoke all sessions |
| POST | /api/auth/password/forgot | public | Send reset token (always 200) |
| POST | /api/auth/password/reset | public | Reset; revoke other sessions + outstanding tokens |
| POST | /api/auth/email/verify | public | Confirm email |
| POST | /api/auth/email/resend | authenticated | Resend verification |
| POST | /api/auth/magic-link | public | Existing admin flow; later member recovery |
| GET | /api/auth/verify | public | Existing admin web redirect flow |
| GET | /api/auth/me | public | Current principal or null |

### Onboarding & membership (`me-membership.ts`)
| Method | Path | Policy | Purpose |
|---|---|---|---|
| GET | /api/plans | public | Catalog: tier, monthly/annual prices, features, inviteOnly lock |
| GET | /api/me/onboarding | member | Resume state: email verified, plan, paid, ID-verification status |
| POST | /api/me/membership/subscribe | member | {planId, period, termsVersion}: create default_incomplete subscription, record terms, return client secret |
| POST | /api/me/membership/confirm | member | Read back subscription, activate membership |
| POST | /api/me/membership/change | active-member | Tier/period change per proration policy |
| DELETE | /api/me/membership | member | Cancel (default at period end; explicit now flag) |

### Identity verification (`id-verification.ts`)
| Method | Path | Policy | Purpose |
|---|---|---|---|
| POST | /api/me/id-verification/photo | member | Multipart government-ID upload; private encrypted storage |
| POST | /api/me/id-verification/submit | member | Submit for staff review |
| POST | /api/me/id-verification/skip | member | Record skip |
| GET | /api/id-verifications | admin | Review queue |
| POST | /api/id-verifications/:memberId/review | admin | Approve / reject |

### Home (`me.ts`)
| Method | Path | Policy | Purpose |
|---|---|---|---|
| GET | /api/me/home | member | First name + greeting basis, upcoming reservations with viewer participation status + inviter for pending invites, quick-book suggestion, spotlight events, amenity summary (empty state) |
| GET | /api/me/qr | member | Short-lived signed QR payload (rotating; never the raw member number) |

### Availability & quotes (`availability.ts`)
| Method | Path | Policy | Purpose |
|---|---|---|---|
| GET | /api/resource-types | member | Types with availability count, hourly rate, tier badge/lock, icon key |
| GET | /api/resource-types/:code/availability?date&days | active-member | Per-date bookable 30-min slots (aggregated across resources, pre-filtered, horizon-bounded) |
| POST | /api/reservations/quote | active-member | {typeCode, date, slots[]}: validates one resource fits the whole range; returns rate, hours, total |

### Directory (`directory.ts`)
| Method | Path | Policy | Purpose |
|---|---|---|---|
| GET | /api/members/search?q= | member | Prefix search by name or member number; members only, never staff |

### Reservations (`reservations.ts`)
| Method | Path | Policy | Purpose |
|---|---|---|---|
| POST | /api/reservations | active-member | {typeCode, date, slots[], invitees{memberIds[], clubIds[]}}: assign resource, insert pending_payment + claim (12-min TTL), create on-session PI; return reservation + clientSecret + holdExpiresAt |
| POST | /api/reservations/:id/confirm | organizer | Assert PI succeeded, flip confirmed; webhook does the same idempotently |
| GET | /api/me/reservations?filter= | member | My reservations incl. my participation status |
| GET | /api/reservations/:id | participant | Detail: resource, times, duration, ref, roster with statuses, viewer capability flags |
| POST | /api/reservations/:id/reschedule-quote | organizer | Delta preview (charge or refund amount) |
| PATCH | /api/reservations/:id | organizer | Reschedule: atomic claim-range update (self-excluding), settle delta, reset confirmed guests to pending, email |
| DELETE | /api/reservations/:id | organizer | Cancel; policy-tiered refund; release claim |
| POST | /api/reservations/:id/participants | participant (policy) | Add invitees (members and/or clubs) as pending; notify |
| DELETE | /api/reservations/:id/participants/:memberId | organizer | Remove a participant |
| POST | /api/reservations/:id/respond | invited participant | {response: accept\|decline}: accept, decline, or withdraw after accept (confirmed -> declined); idempotent; rechecks reservation status in-tx |

### Clubs (`clubs.ts`)
| Method | Path | Policy | Purpose |
|---|---|---|---|
| GET | /api/me/clubs | member | My clubs: cover, name, member count, my role |
| POST | /api/clubs | member | Create (name required) + initial invitees; creator = owner |
| GET | /api/clubs/:id | club member | Detail + caller permission flags |
| PATCH | /api/clubs/:id | club owner | Edit name/description/cover |
| DELETE | /api/clubs/:id | club owner | Delete |
| POST | /api/clubs/:id/leave | club member | Leave (owner must transfer first) |
| GET | /api/clubs/:id/members | club member | Roster: name, member number, role |
| PATCH | /api/clubs/:id/members/:memberId | club owner | Change role / transfer ownership |
| DELETE | /api/clubs/:id/members/:memberId | club owner | Remove member |
| POST | /api/clubs/:id/invitations | club member | Batch invite (pending until accepted) |
| GET | /api/me/club-invitations | member | My pending club invites |
| POST | /api/club-invitations/:id/respond | invitee | Accept / decline |
| POST | /api/clubs/:id/invite-link | club member | Create/rotate share link + QR token |
| POST | /api/clubs/join | member | {token}: join via link/QR |
| GET | /api/clubs/:id/activity | club member | Club-linked reservations, upcoming + past |
| POST | /api/clubs/:id/cover-image | club owner | Multipart cover upload (media pipeline) |

### Account & billing (`me.ts`, `me-billing.ts`)
| Method | Path | Policy | Purpose |
|---|---|---|---|
| GET | /api/me/profile | member | Profile, member number, member since, activity stats (lifetime, computed from reservations) |
| PATCH | /api/me/profile | member | Update display name |
| POST | /api/me/avatar | member | Multipart avatar upload |
| GET | /api/me/preferences | member | Notification prefs |
| PUT | /api/me/preferences | member | Save push/email/booking-reminder toggles |
| GET | /api/me/billing | member | Membership summary, default payment method, month buckets from ledger |
| GET | /api/me/billing/transactions?month= | member | Month's transactions (ledger) |
| POST | /api/me/payment-methods/setup-intent | member | Setup-mode PaymentSheet |
| POST | /api/me/payment-methods/:id/default | member | Set default on customer AND subscription |
| POST | /api/me/devices | member | Register push token |
| DELETE | /api/me/devices/:token | member | Unregister |
| DELETE | /api/me | member + step-up | Account-deletion pipeline (resumable) |

### Admin surface (existing, adapted)
- All existing admin routes annotated `admin`; `req.principal` migration.
- Courts/showers CRUD replaced by: GET/POST/PATCH `/api/resource-types`,
  GET/POST/PATCH `/api/resources` (admin).
- Admin booking create/cancel rewritten onto the reservation service
  (organizer = target member, `createdByAdminId`, comp payment).
- `/api/stripe/*` body-driven routes stay admin-only.

### Webhooks & cron
| Path | Policy | Purpose |
|---|---|---|
| POST /api/webhooks/stripe | webhook | Rewritten per billing design |
| /api/cron/expire-holds | cron | Release stale pending_payment claims (PI-status check first) |
| /api/cron/reconcile-billing | cron | Nightly 72h charges/refunds sweep into ledger |
| /api/cron/subscription-drift | cron | Account-wide subscription check (replaces per-member sync loop) |
| /api/cron/send-booking-reminders | cron | Reminders per member prefs (outbox-driven) |
| /api/cron/materialize-series | cron | Weekly series -> concrete reservations in horizon |
| /api/cron/cleanup-event-images | cron | Existing |

## 4. Schema delta

New: `user_credentials`, `auth_identities`, `auth_sessions`, `auth_tokens`,
`resource_types`, `resources`, `slot_claims` (+ exclusion constraint),
`reservations`, `reservation_participants`, `reservation_payments`,
`reservation_series`, `clubs`, `club_members`, `club_invitations`,
`club_invite_links`, `billing_transactions`, `payment_methods`,
`processed_webhook_events`, `id_verifications`, `devices`,
`deletion_requests`.

Changed: `users` (staffRole, emailVerifiedAt, status, deletedAt, terms
columns), `members` (userId FK, memberNumber, avatarUrl, notification-pref
columns, deletedAt), `membership_plans` (tier, inviteOnly, features,
monthly+annual price rows, sortOrder).

Dropped after cutover: `courts`, `showers`, `bookings`, `club_event_courts`,
`admin_users`, `sessions`, `magic_link_tokens`, `stream_checkpoints`.

Backfills: courts/showers -> resource_types+resources (fail loudly on
divergent per-row config); bookings -> reservations (+claims, de-conflict
overlaps first); ClubEventCourt -> event claims; admin_notes.authorId
phantom-ID repair; ledger backfill from Stripe; members.userId by verified
email match.

## 5. Build packages (fan-out plan)

Order matters for A; B/C/D/E parallelize after their listed deps.

- **P0 Repo reconciliation** (BLOCKED on canonical-repo decision) + pre-flight
  fixes 3, 4, 5, 7, 10.
- **A Identity** (everything depends on it): tables, identity context split,
  policy hook + onRoute assertion + principal rename, password + OAuth +
  refresh flows, linking policy, magic-link preserved for admin. Admin
  behavior byte-identical; forced admin re-login at cutover.
- **B Scheduling** (dep: A): resource model, slot_claims + constraint,
  reservation aggregate + participants, availability + quote, migration +
  backfill, admin route rewrite, ClubEvent claim port, audit events + outbox
  dispatcher.
- **C Billing** (dep: A; interlocks with B on reservation payments): context
  move + gateway pin, ledger + PM mirror + dedupe tables, webhook rewrite,
  subscribe/confirm flow, setup-intent, reschedule-delta settlement, cron
  suite, ledger backfill.
- **D Clubs** (dep: A; B for activity feed reads): full clubs context +
  endpoints + invite links.
- **E Account** (dep: A, C): profile/avatar/prefs/QR/stats, ID verification
  (private storage), devices, deletion pipeline.
- **F Home & notifications** (dep: B, C, D): home aggregation, quick-book
  heuristic, outbox consumers (invite, re-accept, reminders, confirmations),
  Apple relay email domain registration.

Each package lands with unit tests (domain), route tests (app.inject with
mocked container, per existing convention), and migration + backfill scripts.

## 6. OPEN product decisions (recommendations in place; veto anytime)

1. Canonical repo (P0 blocker). Recommend: website monorepo.
2. Cancellation/edit refund tiers. Recommend 100% > 24h, 50% 2-24h, 0%
   inside; per-type fields already exist.
3. Monthly plan price (design shows only $240/yr). Data, not code: a
   MembershipPlan row per period.
4. Club invites require acceptance (recommended; matches invite-link +
   reservation-invite semantics) vs direct-add.
5. Solo bookings: design gates Continue on >= 1 invitee. Recommend allowing
   solo (policy flag), UI can keep its own gate.
6. Reservation invite permission: recommend organizer + confirmed
   participants.
7. Refund destination: card on file (settled by critique; store credit
   rejected).
8. Weekly recurrence: infra + badge now, creation admin-only until a member
   UI is designed.
9. Stats window: lifetime.
10. Booking guests: don't consume inventory or count against limits
    (organizer only).
