# Billing package (C): recorded decisions

Forks resolved while building the billing bounded context, on top of the
settled payments critique. Where this package deviates from the critique's
letter, the deviation and its reason are recorded here; everything else
follows the critique directly.

## The money model: one ledger, one settlement record, one allocator

1. **`billing_transactions` is the member-facing money history;
   `reservation_payments` is the bookings-side settlement record.** They
   are not competing models. `reservation_payments` (package B) drives the
   refund state machine: reserve-pending-then-execute, fail-closed balance
   math, per-reservation advisory locks. `billing_transactions` is an
   append-only projection of Stripe money movement (one row per invoice
   payment, booking charge, refund) carrying domain meaning (kind,
   reservation/membership linkage). Stripe is truth for money movement; the
   ledger is truth for what the money meant.
2. **Ledger writers all converge on `[stripeObjectType, stripeObjectId]`.**
   Three writers upsert on that unique anchor: the webhook service
   (authoritative), the booking-payment adapter's best-effort observations
   (so the debit/credit is visible the moment the member sees
   "confirmed"/"cancelled" instead of webhook-seconds later), and the
   nightly reconcile sweep (closes endpoint downtime, dropped events,
   handlers that failed after acknowledging). Booking charges anchor on the
   CHARGE id (refunds attach to charges), membership fees on the invoice
   id, refunds on the refund id. An adapter observation failure is
   swallowed with an alert: a ledger write must never fail the money path
   it rides on.
3. **The allocation math lives ONCE, in
   `lib/kernel/payment-allocation.ts`** (`computeNetPaidCents`,
   `computeRefundableCents`, `allocateRefund`). The kernel is the only home
   that both `bookings/domain` and `billing/domain` may import without a
   BC cycle (billing already depends on bookings for settlement), matching
   the venue-time precedent. Both domain barrels re-export it. The move
   also fixed a latent over-allocation bug when two charges share one
   payment intent (refund remainders are now carried across charges, never
   zeroed).
4. **Disputes freeze refundability, not balance.** `charge.dispute.created`
   stamps `reservation_payments.disputedAt`; a disputed charge still counts
   as captured money (`netPaid`) but contributes zero refundable balance.
   Cancelling a disputed reservation SUCCEEDS with the refund withheld and
   audited (`withheldDisputedCents`) rather than failing: a member must
   always be able to free a slot, and club-event force-cancels must never
   be blocked by one disputed booking.

## Deviations from the critique (with reasons)

5. **Fetch-time ordering guard instead of a monotonic `currentPeriodEnd`
   guard.** The critique's monotonic-periodEnd guard does not order status
   changes inside one period (active -> canceled -> stale-active still
   interleaves) and wrongly rejects legitimate backward period moves
   (interval changes reset the anchor). Every subscription apply now
   carries `stripeFetchedAt` (taken from Stripe's own response Date header,
   immune to instance clock skew) and the guarded update refuses to let an
   earlier fetch overwrite a later one, plus a hard "no exit from
   `canceled`" clause (Stripe never reactivates a canceled subscription, so
   only a stale snapshot could). This is the stronger form of the same fix
   and kills both critique bugs (backward move, cancel-then-resurrect);
   both have tests.
6. **`Membership.memberId` is no longer unique: one row per Stripe
   subscription.** Re-subscribing after cancellation is a NEW subscription
   id, and Stripe allows a customer parallel subscriptions, so
   upsert-by-subscriptionId with a unique memberId cannot represent
   reality (P2002 on the second row). Webhook apply is now a pure upsert by
   `stripeSubscriptionId` with zero member-resolution branching; "the
   member's current membership" is a query (`pickCurrentMembership`:
   entitled > past_due > mid-purchase > dead, latest period end within a
   rank), shared by the members repository, the bookings membership
   checker and the memberships repository.
7. **Annual->monthly downgrade rides a transient subscription schedule,
   not `proration_behavior: 'none'`.** The SDK documents that a plain price
   update switching billing intervals "still resets the billing date and
   bills immediately" even with proration none, i.e. it would double-charge
   the member and shorten the paid annual period. Instead:
   `subscriptionSchedules.create({ from_subscription })`, then two phases
   (current price to period end; target price for one billing cycle) with
   `proration_behavior: 'none'` at both levels and
   `end_behavior: 'release'` so the schedule detaches itself. Any attached
   schedule is RELEASED before an upgrade or a cancel (a stale phase 2
   would silently revert an upgrade; `subscriptionSchedules.cancel` would
   kill the subscription immediately). Pending-downgrade state
   (`stripeScheduleId`, `pendingPlanId`, `pendingPlanEffectiveAt`) lives on
   the membership row and clears when the schedule detaches.
   `subscription_schedule.*` events are subscribed as plain subscription
   triggers.
8. **Subscription statuses are stored verbatim with an exhaustive
   mapping** (`normalizeSubscriptionStatus`), never an unchecked cast. The
   union gained `trialing`, `incomplete_expired`, `paused`; an unknown
   future status maps fail-closed to `unpaid` and alerts. `trialing`
   counts as entitled (no trials are sold, but a dashboard-created trial
   must not lock a paying member out).

## Purchase, change, cancel

9. **Subscription-first purchase** exactly per the critique:
   `default_incomplete`, `save_default_payment_method: 'on_subscription'`,
   `latest_invoice.confirmation_secret` handed to PaymentSheet together
   with an ephemeral key minted at `STRIPE_MOBILE_API_VERSION` (env
   override; falls back to the server pin) and the customer id.
   `POST /api/me/membership/subscribe` records terms acceptance
   server-side (users row via the memberships `TermsRecorder` port +
   subscription metadata) BEFORE the subscription exists.
   `POST /api/me/membership/confirm` re-fetches and applies through the
   SAME guarded path as the webhook; the app never waits on a webhook.
10. **Subscribe re-entry:** an in-flight `incomplete` purchase of the same
    plan returns a fresh confirmation secret (no orphan subscription per
    retry); an abandoned `incomplete` purchase of a different plan is
    voided at Stripe before the new one is created.
11. **Plan-change direction rule:** upgrade = tier raise, or monthly->
    annual at the same tier, or price raise at the same tier+interval;
    upgrades apply immediately with `create_prorations` (SCA on the
    proration invoice surfaces as a confirmation secret); everything else
    schedules at period end (decision 7). Changing back to the current
    plan while a downgrade is pending just releases the schedule.
    Invite-only plans (PRO) cannot be self-served until an invite
    mechanism exists (`TODO(package-d)`); blocked with 403.
12. **Cancel** (`DELETE /api/me/membership`): default `cancel_at_period_end`;
    explicit `?now=true` cancels immediately with no refund. Policy is
    `member`, not `active-member`: a past_due member must be able to
    cancel.

## Booking payments

13. **The real `BookingPaymentPort` adapter** creates on-session
    PaymentIntents (`automatic_payment_methods` + `allow_redirects:
    'never'`), server-authoritative amounts, `metadata.reservationId` both
    directions, idempotency key `reservation:{id}:attempt:{n}`, and creates
    + persists a Stripe customer for first-time payers. A declined intent
    stays confirmable in-sheet (PI reuse). Refunds are keyed by the
    RESERVED settlement row id (`refund:{rowId}`), passed through a new
    required `refundKey` on the port: stable across crash-retries, never
    colliding two legitimate same-amount refunds. Sub-minimum charges
    (< $0.50) are BLOCKED with `MinimumChargeNotMetError` (422), not
    absorbed; zero-delta reschedules create no intent and no ledger row
    (settled in B).
14. **The webhook/reconcile settlement entry point is
    `reservationService.handleCapturedPayment`**, which routes through B's
    `confirm()` (never a parallel implementation) and adds the one case
    confirm cannot reach: a capture landing on a CANCELLED reservation
    (the pay-vs-drop TOCTOU residual from decisions-scheduling 20). The
    orphaned capture is acknowledged (pending/failed -> succeeded; a
    Stripe capture is ground truth) and refunded at the percent the
    cancellation actually applied (persisted as
    `reservations.cancelRefundPercent`; a grow delta refunds 100% since
    the time was never delivered; a 0% tier keeps it all). A missing
    charge row (crash between PI create and row insert) is recreated from
    the intent under the reservation lock. The handler never throws for
    expected terminal states, so the webhook's retry budget is spent only
    on genuine transients; an invisible reservation row still 500s so
    Stripe retries (critique edge case 4).
15. **Dashboard-initiated (goodwill) refunds flow into BOTH records:**
    the ledger row via the refund events/sweep, and
    `reservationService.recordExternalRefund` (idempotent by
    `stripeRefundId`, now unique) so B's refundable balance stays
    truthful. Async refund failures (`refund.failed` days later) flip the
    settlement row back and restore the paid total
    (`reconcileRefundOutcome`); the schedule change stands and staff are
    alerted (`TODO(package-f)` notification).
16. **`reservation_payments.purpose`** (`base` | `change_delta`) makes the
    charge's meaning relational (needed by 14's percent decision; the
    pending-change linkage is destroyed at cancel time).

## Webhooks

17. **Dedupe: check at start, record ONLY after success, event id only.**
    A failure leaves no tombstone, so Stripe's retry genuinely
    reprocesses; concurrent duplicate deliveries both run but every
    handler is idempotent (guarded upserts, CAS, unique anchors). Rows are
    pruned after 30 days by the reconcile cron.
18. **500 on transient failure; 200 only for handled, ignored or
    duplicate.** Permanently unhandleable events (price not in
    `membership_plans`, unresolvable member) are alerted loudly and
    acknowledged so the retry budget is not burned on events that can
    never succeed; the reconcile sweep and drift check are the safety net.
    This replaces the catch-all 200 and the silent null-plan no-op.
19. **Subscribed events:** checkout.session.completed (legacy admin flow),
    customer.subscription.created/updated/deleted, subscription_schedule.*,
    invoice.paid, invoice.payment_failed, invoice.payment_action_required,
    payment_intent.succeeded/payment_failed, charge.refunded,
    refund.created/updated/failed, charge.dispute.created,
    payment_method.attached/detached/updated/automatically_updated.
    Everything subscription-shaped re-fetches and applies; money events
    re-fetch the object (trigger pattern), never trusting the event
    payload except for immutable dispute linkage ids.

## Reads, cron, ops

20. **Billing reads come from the local ledger only** (`GET
    /api/me/billing` month buckets + default card + card list, `GET
    /api/me/billing/transactions?month=`). Month grouping happens in the
    venue timezone via the kernel's zone math (`monthKey`/`monthRangeUtc`;
    same semantics as date_trunc AT TIME ZONE, one implementation, unit
    tested); a Jan 31 8pm ET charge files into January.
21. **Payment methods:** `POST /api/me/payment-methods/setup-intent`
    (setup-mode PaymentSheet payload) and `POST
    /api/me/payment-methods/:id/default`, which sets the default on BOTH
    `customer.invoice_settings.default_payment_method` AND the live
    subscription's `default_payment_method`, verifies the pm belongs to
    the caller's own Stripe customer (404 otherwise), and updates the
    mirror immediately. The mirror is fed by payment_method.* webhooks
    (including `automatically_updated`, the card-account-updater); a
    member's first card becomes the mirror default.
22. **Cron:** `/api/cron/reconcile-billing` (nightly 72h sweep of charges +
    paid invoices + refunds, upserted into the ledger; re-drives
    settlement via handleCapturedPayment; prunes dedupe rows) and
    `/api/cron/subscription-drift` (one account-wide subscriptions.list
    applied through the same guarded path; a local row missing from the
    account listing is ALERTED as a possible test/live key swap, never
    auto-canceled). The per-member syncFromStripe loop is deleted. All
    cron routes answer GET as well as POST (URL schedulers issue GETs; the
    CRON_SECRET is the guard). vercel.json lists every cron.
23. **Membership-fee reconciliation uses invoices.list**, not
    charge->invoice linkage (the invoice field on charges/intents is not
    stable across current API shapes); booking charges are classified by
    `metadata.reservationId`.
24. **Backfill:** `npm run job:backfill-billing-ledger` imports historical
    charges/invoices/refunds into the ledger. Ledger-only by design: it
    never drives settlement (historical reservations settled long ago;
    legacy bookings pre-date the reservation model). Idempotent.
25. **Adapter selection:** the container wires the real Stripe adapter
    whenever `STRIPE_SECRET_KEY` is set, and ALWAYS in production (a
    missing key fails payments closed rather than booking for free); the
    instant-success stub survives only for keyless local development,
    with a boot warning.

## Account deletion (the seam package E calls)

26. **`billingService.assertClosable` / `closeBillingForMember`**: blocked
    while a refund is in flight or a dispute is open (both records
    checked); then cancel the subscription immediately (releasing any
    schedule first), detach every payment method, tag the Stripe customer
    `metadata.deleted_at`. NEVER `customers.del()`; the ledger and
    `stripeCustomerId` are kept (retention + chargeback windows), and a
    re-signup mints a fresh customer. The deletion pipeline itself
    (step-up re-auth, reservation cancellation, anonymization) is
    `TODO(package-e)`; `Member.deletedAt` lands with it.

## Known accepted edges

27. Two concurrent reschedule-grow requests with different targets can
    collide on the per-attempt idempotency key and one fails with a clean
    Stripe 400 before anything is written; the user retries. Making the
    key a pre-generated row id would require restructuring B's reviewed
    checkout transaction for a harmless race; not worth it.
28. The adapter's ledger observations and the PM-mirror `isDefault`
    heuristic are best-effort projections; the webhook stream and nightly
    sweep are the converging authority.
29. `GET /api/me/billing` also returns the full card list (the edit sheet
    needs it); a dedicated list endpoint was not added.

## Review fixes (2026-08-10, post-package-C money review)

30. **Reserved refunds are ADOPTED by `refundKey`, never double-recorded.**
    The adapter stamps the reserved settlement-row id into the Stripe
    refund's `metadata.refundKey`; ingestion (webhook + sweep) carries it
    on `RefundData`, and `recordExternalRefund` stamps the observed
    `stripeRefundId` onto that row (CAS on NULL) instead of inserting a
    duplicate. Closes the window between `refunds.create` and
    `completeRefund` in which our own refund looked external: a crash or a
    fast inline webhook there used to create a second row,
    double-decrement `amountPaid` and (in the non-crash race) blow up
    `completeRefund` on the unique `stripeRefundId`. Adoption also
    converges a locally-failed row whose `refunds.create` actually went
    through (flip failed -> succeeded, re-apply the decrement).
31. **Multi-PI refund batches attempt EVERY allocation; the nightly
    reconcile re-drives stranded reserved refunds.** `executeReservedRefunds`
    no longer aborts on the first Stripe failure (which stranded later
    allocations as pending rows with decremented balance and nothing in
    flight); each failure is terminalized per-row (failed + restore +
    staff-alert seam) and the first error rethrown after the batch.
    `redriveStalePendingRefunds` (new `BookingSettlementPort` member, run
    by `/api/cron/reconcile-billing` AFTER its refund ingestion sweep)
    re-executes reserved rows still pending with no `stripeRefundId` after
    60 minutes under their per-row idempotency keys, so a crash between
    the reserving commit and the Stripe call can no longer strand money
    owed to a member (or permanently block account closure via the
    pending-refund count).
32. **Orphaned captures on CONFIRMED reservations are refunded, and every
    best-effort void routes through recovery.** The confirmed-reservation
    variant of the pay-vs-drop TOCTOU (a superseded/dropped/swept change
    delta whose on-session intent captured after `dropPendingChange`
    judged it unpaid) was unrecoverable: `confirm()` no-ops without a
    pending change and the row sat `failed` while the member stayed
    charged. `handleCapturedPayment` now acknowledges any captured charge
    on a confirmed reservation that is not the live pendingChange's charge
    and refunds it in full (capped at refundable balance so a dispute
    freeze withholds instead of throwing), and every post-commit
    `cancelPaymentIntent` goes through `voidOrRecoverIntent`, which
    dispatches a failed void straight back into `handleCapturedPayment`.
    The webhook and nightly reconcile drive the same entry point, so the
    residual race self-heals within a night even if the inline repair
    misses.
33. **`resource_missing` NEVER cancels a membership.** The code violated
    decision 22: the drift orphan re-check routed through
    `applySubscriptionState`, whose resource_missing branch force-canceled
    the row — on a test/live key swap that mass-canceled every membership,
    irreversibly (no-exit-from-canceled guard). Both the listing and the
    individual retrieve run under the same possibly-swapped key, so the
    re-check cannot discriminate a swap from a real deletion; a genuinely
    deleted/canceled subscription still retrieves as `status=canceled` and
    flows through the guarded apply. The missing branch now alerts and
    changes nothing; `markCanceledBySubscriptionId` (an unguarded
    updateMany) is deleted outright.
34. **The drift sweep stamps `fetchedAt` from Stripe's Date header,
    per page.** `listAllSubscriptions` paginates by hand and stamps each
    page from its own response header instead of one local `new Date()`
    taken before the sweep, restoring decision 5's clock-skew immunity
    (a skewed instance could otherwise overwrite newer webhook state with
    a stale sweep snapshot).

## Validation record (2026-08-10)

Full migration chain (0001_init through 20260810200000_billing) applied to
a throwaway Postgres 16 container twice: once onto an empty database +
seed (re-seeded twice to prove membership upsert idempotency under the
new one-row-per-subscription model), once as an upgrade of a
package-B-shaped database with fixture data (existing memberships,
reservations with payments, a pending change). `prisma migrate diff`
reported zero drift against schema.prisma both times. Live checks: the
partial-unique-free refund ingestion path (unique `stripeRefundId`),
`purpose` backfill of pending-change delta charges, and the
`memberships_memberId_key` drop with re-subscribe inserting a second row
for one member.
