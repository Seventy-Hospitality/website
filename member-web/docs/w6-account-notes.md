# W6 account flow: notes and backend follow-ups

Same discipline as the other flow notes: decisions taken and gaps found
while building the account section, with where the client copes today.

## "Claim Clutch session stats & clips" is parked (by decision)

The backend never built it (`api/docs/decisions-account.md`: "parked and
not built"), but the Figma account menu (168:15494) shows the row. The
client renders it as an inert row with a "Coming soon" caption so the
menu matches the design without offering a dead action. Delete the row in
`AccountPage.tsx` if the feature is ever formally dropped.

## Static links have no destinations yet (known)

Privacy policy, Terms of Service, Contact us, and Rate the app
(app-preferences 107:9789) have no target anywhere in the product: no
docs routes, no support address in the repo, no store listing. They
render as inert "Coming soon" rows instead of dead links. When real
destinations exist, swap `ComingSoonRow` in `AppPreferencesPage.tsx` for
links. The About "Version" value is baked at build time from
package.json (`__APP_VERSION__` in vite.config.ts).

## "Active since" is not in the billing payload (backend gap)

The Figma billing card (107:10434) shows "Active since Mar 2025", but
GET /api/me/billing serializes no membership start date (only
currentPeriodEnd / cancelAtPeriodEnd / pending plan). The card shows the
forward-looking state instead ("Renews ...", "Ends ...", "Switches to
... on ...", "Payment past due", "Ended ..."), which is more actionable
anyway. If design fidelity is wanted, the backend would add the
subscription's start date to the overview.

## One query for GET /api/me/billing

W6 widened `api.getMyMembership` to the full `BillingOverview` rather
than adding a second endpoint read: the `['membership']` key (W1's
onboarding gate) IS the billing page's overview query, so there is
deliberately no separate `['billing']` overview key to drift out of
sync. Month transactions live under `['billing', 'transactions', month]`
and are fetched lazily on first expand. Money-state mutations (plan
change, cancel, set-default card) invalidate `['membership']` plus the
`['billing']` prefix; profile mutations invalidate `['profile']`,
`['home']`, and `['clubs']` (rosters carry displayName/avatar).

## Processing SetupIntent: no server-side auto-default (backend gap)

A SetupIntent that confirms into `processing` (delayed methods; cards
complete inline) saves the payment method but nothing promotes it once it
clears: the webhook service has no `setup_intent.succeeded` case, and the
`payment_method.attached` mirror marks a card default only when it is the
member's FIRST one. The web client therefore treats `processing` as
incomplete, not success: the hold says the previous payment method stays
the default and offers "Check again", which re-reads the intent
(`stripe.retrieveSetupIntent`) and runs the normal
POST /payment-methods/:id/default on `succeeded`. A member who abandons
the hold ends with the new method attached but NOT default. Backend
follow-up: handle `setup_intent.succeeded` by calling
`setDefaultPaymentMethod` for the intent's payment method so the switch
converges without the client.

## Transaction row dates are device-local, months are venue-local (backend gap)

GET /billing serializes ledger months bucketed in VENUE_TIMEZONE, but each
transaction carries only its `occurredAt` ISO instant and the API exposes
no venue timezone (the same gap W3 recorded for `todayDateKey`). The
client renders row dates with `instantDateLabel` in the device zone, so
near a month boundary a viewer whose zone differs from the venue's can see
a row dated in the adjacent month under its venue-month header (e.g. a
`2026-08-01T02:00:00Z` charge in a Los Angeles venue sits in "July 2026"
but renders "Aug 1, 2026" for a UTC+2 viewer). Cosmetic and narrow, but
the fix is backend-shaped: expose VENUE_TIMEZONE (or venue-local dates on
the rows) and format with it here and in W3.

## Cancel stays available for live-but-not-active memberships

DELETE /api/me/membership deliberately uses policy `member` ("a past_due
member must still be able to cancel"), so the web mirrors it with
`canCancelMembership` (any status except canceled / incomplete_expired):
the billing card swaps "Change membership" for a "Cancel membership" row
in those states, and the change screen renders its cancel zone while
hiding the plan switcher (plan changes still need the backend's
active-member policy).

## Lapsed members cannot re-subscribe on web (known)

A canceled membership renders on the billing page as "Ended <date>" with
a contact-the-club hint; the change-membership screen requires an active
membership (the backend's `active-member` policy) and the onboarding
checkout is fenced off once a membership was ever live. The backend
already supports re-subscribing (POST /api/me/membership/subscribe
allows it when the current membership is not entitled/past_due); a
renewal surface reusing W1's checkout is a follow-up if self-service
renewal is wanted.

## Failed proration payment after a redirect (by backend design)

Upgrades use Stripe's `allow_incomplete`: the plan switches immediately
and the proration invoice is collected separately. If a redirect-based
payment method comes back `failed`, the switch has already happened; the
client says so plainly ("Your plan was changed, but the payment did not
complete...") and points at the payment method. Stripe retries the open
invoice; a persistent failure surfaces as "Payment past due" on the
billing card via the normal webhook path.

## Delete-account step-up: emailed code instead of OAuth on web

DELETE /api/me accepts three proofs (password, fresh OAuth assertion,
emailed re-auth code). The web client collects the current password for
password accounts and the emailed code (POST /api/me/reauth-email,
session-bound, 10 min TTL) for everyone else; the backend accepts
reauth_email for every account, so wiring the Google/Apple SDKs into the
deletion flow buys nothing. `GET /api/me/auth-identities` picks the UI.
Any 202 (completed / in_progress / failed-with-retry) signs out locally;
409 DELETION_BLOCKED renders the blocked state with the backend's
reasons verbatim.

## Avatar is replace-only in the UI

The Figma shows only the camera badge (upload/replace); DELETE
/api/me/avatar (remove photo, back to initials) exists but has no
affordance in the design, so the client does not call it.
