# Home & notifications package (F): recorded decisions

Forks resolved while building the final Club70 package: notification
delivery over the outbox, booking reminders, weekly-series
materialization, and the home aggregation with the quick-book heuristic.
OPEN-decision recommendations from `club70-app-api-plan.md` were applied
as noted.

## Applied plan recommendations

1. **Weekly recurrence: infra + badge now, creation admin-only (OPEN 8,
   applied).** `reservation_series` is live: the materialize cron turns
   active series into concrete reservations and every reservation carries
   `weekly: seriesId !== null` (the badge). Series CREATION and
   cancellation are `admin`-policy routes
   (`GET/POST /api/admin/reservation-series`,
   `DELETE /api/admin/reservation-series/:id`) until a member UI is
   designed. Because creation is admin-only, `createdByAdminId` is NOT
   NULL and materialized occurrences are COMP reservations (the admin
   create semantics: confirmed immediately, no hold, no payment). When
   members can create series, occurrences will need a payment story;
   that is deliberately out of scope now.

## Delivery architecture

2. **The outbox consumer is the communications context.**
   `NotificationDispatchService` implements the dispatcher's `OutboxSink`.
   The DECISION (event -> recipients -> channels) is a pure domain matrix
   (`communications/domain/notification-decision.ts`); resolution of
   recipient references (a reservation's organizer, a club invitation's
   inviter) and template context happens through narrow read ports wired
   in the container over the members/bookings/clubs public surfaces. The
   dispatcher keeps `FOR UPDATE SKIP LOCKED` + `dispatchedAt` selection;
   it now marks ONLY delivered rows dispatched, and events whose delivery
   failed stay pending and retry (retry, never drop).

3. **Idempotency = the delivered-notifications ledger.** One row per
   `(eventSeq, recipient, channel)`, claimed BEFORE sending:
   claim -> send -> mark sent. The ledger writes auto-commit OUTSIDE the
   dispatch transaction on purpose: a batch that fails halfway rolls the
   outbox pass back, but the "sent" marks survive, so the retry re-sends
   only what never went out. A claim that never reached "sent" (send threw,
   process crashed) is re-claimed on the next pass. Concurrent dispatchers
   cannot double-send: SKIP LOCKED keeps them off the same event rows and
   the ledger's unique key arbitrates any residual overlap. The one
   unavoidable at-least-once edge: a crash BETWEEN a provider accepting the
   send and the mark landing re-sends that single notification.

4. **Event -> notification matrix** (everything else in the audit log is
   audit-only and notifies nobody):

   | Outbox event | Recipient(s) | Channels |
   |---|---|---|
   | `reservation.participant_invited` | invited member | push + email |
   | `reservation.invite_accepted` | organizer | push |
   | `reservation.invite_declined` | organizer | push |
   | `reservation.participant_withdrawn` | organizer | push |
   | `reservation.rescheduled` | the reset (must re-accept) guests | push + email |
   | `reservation.confirmed` | organizer | email (receipt) |
   | `reservation.cancelled` | confirmed + pending participants, minus the actor | push + email |
   | `reservation.created` with `seriesId` | organizer | push + email |
   | `reservation_series.occurrence_skipped` | series organizer | push + email |
   | `club.invitation_sent` | invitee | push + email |
   | `club.invitation_accepted` | inviter | push |
   | `id_verification.approved` / `.rejected` | member | push + email |
   | `billing.payment_failed` | member | email |
   | `billing.dispute_opened` | staff | email |
   | `reservation.refund_failed` | staff | email |
   | `account.deletion_blocked` | staff | email |

   Notes: social kinds never echo the acting member back to themselves
   (`suppressActor`); receipts (booking confirmation) do go to the actor.
   `reservation.participant_removed` is deliberately silent (being removed
   is not broadcast). `reservation.dispute_opened` stays audit-only: the
   staff alert rides `billing.dispute_opened`, which the webhook appends
   for linked AND unlinked disputes. `account.deleted` sends nothing (the
   member's channels were destroyed at quiesce). Membership dunning rides
   the outbox as `billing.payment_failed`, appended by the webhook after
   `invoice_failed` resolves to a membership.

5. **Preferences gate everything member-facing.** `planChannels` applies
   the member's independent toggles: push requires `pushNotifications` AND
   at least one registered device (delivery goes to every registered
   device); email requires `emailNotifications`; booking reminders
   additionally require `bookingReminders`. Security/account email
   (verification, password reset, re-auth codes) does NOT ride the outbox
   and is not gated: it goes directly through `NotificationService` as
   before. Staff alerts ignore member preferences (operational, not a
   subscription).

6. **Push is Expo-shaped and config-gated like Resend.**
   `ExpoPushAdapter` posts to the Expo push HTTP API in batches of 100
   with `EXPO_PUSH_ACCESS_TOKEN`; without the token it logs instead of
   sending, exactly as `ResendAdapter` degrades without `RESEND_API_KEY`.
   Decision + ledger logic run for real either way, so keyless
   environments exercise everything but the external call. Follow-up
   (recorded, not built): consume Expo receipts to prune dead device
   tokens (`DeviceNotRegistered`); until then a dead token is dropped by
   Expo server-side and re-registration replaces it.

7. **Staff alerts go to `STAFF_ALERT_EMAIL`.** One configured address
   (ledger recipient `"staff"`). Unset means staff alerts are logged and
   dropped while the event still dispatches; production should set it.
   Chosen over emailing every admin user: alert fatigue and PII spread
   for zero routing value at this scale.

8. **Unresolvable context evaporates the notification.** A recipient,
   reservation, or club that no longer exists by dispatch time means
   there is nothing to say: the decision resolves to zero recipients and
   the event dispatches as audit-only. Poison events therefore cannot
   wedge the outbox; a genuinely failing SEND, by contrast, keeps the
   event pending and retries forever (cron cadence is the backoff; no
   retry cap at this scale, revisit if a provider outage ever backlogs).

## Booking reminders

9. **Window: starts within the next 24 hours; cron hourly.** Confirmed
   reservations starting inside `[now, now + 24h)`, reminding CONFIRMED
   participants only (pending invitees still have the invite itself to
   answer). A reservation booked inside the window gets one reminder on
   the next cron pass, which doubles as its heads-up. Idempotent per
   `(reservationId, memberId)` via the `booking_reminders` markers, same
   claim -> send -> mark discipline as the ledger; "sent" means at least
   one channel delivered (a partial channel failure does NOT re-send the
   channel that worked; a member whose every enabled channel failed stays
   pending and retries). An opted-out member burns no marker, so
   re-enabling reminders inside the window still gets their one reminder.

## Weekly series materialization

10. **Materialization is horizon-bounded and never shifts silently.**
    `/api/cron/materialize-series` (daily) books each active series'
    occurrences whose venue-local weekday matches, whose start is still
    ahead, and whose date is within the type's `maxAdvanceDays`, through
    the SAME create path as bookings (daily limit and active-membership
    checks included; tier is bypassed like any admin comp). An occurrence
    that cannot be created is recorded in `reservation_series_skips`
    (reasons: `slot_unavailable`, `daily_limit`, `membership_inactive`)
    and the organizer is notified exactly once via the
    `reservation_series.occurrence_skipped` outbox event, committed
    atomically with the marker. Idempotency is structural: one
    reservation per `(seriesId, localDate)` (raw-SQL partial unique, so a
    cancelled occurrence stays cancelled and concurrent crons cannot
    double-book a week) plus the unique skip marker.

11. **Cancelling a series cancels its future occurrences.** Deactivation
    (CAS on `active`) stops materialization, and still-upcoming
    materialized reservations are cancelled through the normal
    reservation cancel path with `fullRefund` (comp bookings refund
    nothing but release their claims and notify participants through the
    usual `reservation.cancelled` events).

## Home aggregation

12. **Home is its own small read context** (`lib/contexts/home`), not a
    bolt-on to `account`: the account BC is the deletion saga only
    (decisions-account.md), and the home screen is pure cross-context
    READ composition with its own domain logic (greeting, quick-book).
    `HomeService` owns no tables and reaches
    bookings/clubs/events/members exclusively through container-wired
    ports over their public surfaces, every read keyed on the caller's
    member id (IDOR-safe by construction). The route keeps the legacy
    `member` / `upcomingBookings` keys for existing clients and adds
    `greeting`, `upcomingReservations` (viewer participation + `weekly`),
    `pendingInvitations` (distinct, inviter first name, inline
    accept/decline), `clubInvitations`, `quickBook`, and `amenities`
    (empty-state only).

13. **Greeting timezone: client-supplied when valid.** `GET
    /api/me/home?tz=<IANA>` computes time-of-day (morning < 12:00,
    afternoon < 17:00, evening otherwise) in the client zone when it
    validates, the venue zone otherwise. First name is the member's legal
    first name (displayName is a directory/profile concern).

14. **Quick-book heuristic (deterministic, no ML).** Habit source: the
    member's PAST confirmed bookings as organizer from the last 90 days,
    cap 50, newest first. Pattern: most frequent amenity type, then most
    frequent weekday within that type, then most frequent start time and
    duration within that (type, weekday); EVERY tie breaks toward the
    most recent booking. Proposal: on the next two matching weekdays
    inside the horizon, the available start nearest the habitual time
    whose whole contiguous range passes the single-resource fit check
    (union availability can lie across resources, so each candidate is
    verified through the quote path; at most 5 fit checks per date). A
    habit for a locked/retired amenity, or no history at all, falls back
    to the most-available unlocked amenity today (an hour when a pair of
    slots fits, one slot otherwise); nothing bookable omits the
    suggestion. The `reason` string states which rule fired.

## Infrastructure notes

15. **`OutboxSink` now reports per-event failures** instead of throwing
    away the whole batch: `deliver` returns `failedEventIds`, the
    dispatcher marks the rest dispatched, and `NoopOutboxSink` is gone
    (the container wires the real consumer). A sink that throws outright
    still aborts the pass and keeps the whole batch pending.

16. **Webhook-side producers.** `WebhookService` gained the audit
    log + UoW to append `billing.payment_failed` and
    `billing.dispute_opened`. A webhook retry after a failure BETWEEN the
    append and the dedupe mark can duplicate the outbox row (two seqs =
    two sends); accepted as a vanishingly rare double-email, the same
    class of edge as decision 3's crash window.

17. **Config.** New env: `EXPO_PUSH_ACCESS_TOKEN` (push gating),
    `STAFF_ALERT_EMAIL` (staff alerts). Cron schedule
    (vercel.json): `dispatch-outbox` and `expire-holds` every 5 minutes,
    `send-booking-reminders` hourly, `materialize-series` daily 02:15,
    `resume-deletions` every 30 minutes (was missing from the config
    since package E), nightly `reconcile-billing` / `subscription-drift`
    / `cleanup-event-images` unchanged.

## Validation

The full migration chain (through `20260811130000_notifications_series`)
was applied to a throwaway Postgres 16 container; `prisma migrate diff`
(applied DB vs schema datamodel) reported zero drift, partial uniques
included. The dispatch/reminder/materialization behaviors are pinned by
unit tests over the same claim semantics the repositories implement.
