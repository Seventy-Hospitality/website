# Club70 mobile app: parity plan

Bring the existing Expo app (`mobile/`) to full parity with the finished web
client and backend: the same six flows, 1:1 with the Figma phone frames.

## Current state (verified)
- Expo SDK 54, expo-router 6, RN 0.81, react-query, react-hook-form + zod
  (partial). Bearer-token auth via expo-secure-store, magic-link ONLY.
- Own dark-green design tokens (close to Figma), no custom font, no tests.
- Screens present: home (thin), booking, account (partial). Onboarding,
  reservations/invites, clubs are MISSING.
- BROKEN: booking/events/billing call admin-only or legacy endpoints
  (`/api/courts`, `/api/showers`, `/api/events`, `/api/stripe/*`) that a member
  token gets 403 on. All must be rewired to the new member engine.

## Locked decisions
- **Extend**, do not rebuild: keep Expo Router, SessionProvider, react-query,
  the RN component set; grow them.
- **Tabs = Home / Reserve / Clubs / Account** (Figma bottom bar). Drop the
  legacy "Connect" events tab; events surface in Home's spotlight only.
- **Re-sync design tokens + fonts to the finished web client**
  (`member-web/src/theme/tokens.ts`: bg `#1e2a20`, accent `#ecfeaa`, Manrope
  display + Inter body) so the two clients look like one product.
- **Auth**: password + magic-link now; native Google/Apple wired but degrading
  until OAuth web/native client IDs are supplied. Fix the contract: send
  `X-Client-Type: mobile`, capture + persist `refreshToken`/`expiresAt` from the
  magic-link callback, implement `POST /api/auth/refresh` (bearer refresh).
- **Payments**: `@stripe/stripe-react-native` PaymentSheet. The backend billing
  was built for this (subscribe/confirm return `clientSecret` +
  `ephemeralKeySecret`; booking create + payment-method setup return client
  secrets).
- **Backend unchanged**: everything mobile needs already exists.

## Endpoint rewire (off the broken admin/legacy calls)
- Facilities/availability: `GET /api/resource-types`,
  `GET /api/resource-types/:code/availability` (day-bucketed), `GET /api/venue`.
- Booking: `POST /api/reservations/quote` -> `POST /api/reservations`
  (returns clientSecret) -> PaymentSheet -> `POST /api/reservations/:id/confirm`.
- Membership: `POST /api/me/membership/subscribe` + `/confirm` (PaymentSheet),
  `/change`, `DELETE /api/me/membership`; plan catalog `GET /api/plans`.
- Billing: `GET /api/me/billing`, `/billing/transactions`,
  `/payment-methods/setup-intent`, `/payment-methods/:id/default`.
- Home: consume the full `GET /api/me/home` payload (greeting, pendingInvitations,
  clubInvitations, quickBook, amenities), not just legacy `upcomingBookings`.

## Packages (fan out, each with a review gate)
- **M0 Foundation**: re-sync tokens + load Manrope/Inter; extend the RN design
  system (Avatar, Badge, Sheet/Modal, FormField/Input, QRCode, ListRow, Toast);
  auth (password + magic-link + X-Client-Type + refresh + OAuth port that
  degrades without creds); API client rewired + typed to the new engine +
  react-query; Stripe provider (`StripeProvider` + PaymentSheet helper);
  tab shell Home/Reserve/Clubs/Account; jest + RN-testing-library harness.
- **M1 Onboarding**: plan select (`GET /api/plans`), Stripe PaymentSheet
  membership subscribe/confirm, ID-verification photo (image picker) submit/skip,
  onboarding-resume gate (`GET /api/me/onboarding`).
- **M2 Home**: rich home from `/api/me/home` (greeting, quick-book, upcoming
  reservations w/ participation + weekly badge, inline invitation accept/decline,
  club invitations, spotlight events, empty state), member QR card sheet.
- **M3 Booking**: resource-type list, availability (date rail + 30-min slots),
  multi-slot select, invite players (member search + club "add all"), quote,
  create + PaymentSheet + "securing your spot" + confirm, confirmation sheet.
- **M4 Reservations**: detail (roster + statuses), accept/decline/withdraw,
  edit/reschedule (delta + PaymentSheet for a grow charge), cancel (tiered
  refund), invite more.
- **M5 Clubs**: list, create wizard, detail + activity, members roster + owner
  actions, invite modal (member picker + copy link + QR + share), join via link.
- **M6 Account**: profile + avatar upload, lifetime stats, member QR card,
  notification preferences, device/push registration, billing history, payment
  methods (setup-intent PaymentSheet + set default), membership change/cancel,
  delete account (step-up), Google/Apple identity linking.

## Verification (honest limits)
No iOS/Android simulator in this environment. Gate = `tsc --noEmit` clean, jest
tests, Figma-frame fidelity (the phone frames are exact), and adversarial code
review per package. `expo start --web` (react-native-web) can render the
non-native screens for a rough visual check; native modules (PaymentSheet,
Apple auth, secure-store, camera) will not render there. The owner runs it on a
real simulator/device.

## Standing conventions (set by M0, enforced in review)
- react-query for all data; loading/error/empty states on every screen.
- Forms via react-hook-form + zod; tokens only (no hardcoded colors).
- Bearer token in expo-secure-store, never logged; `X-Client-Type: mobile`.
- PaymentSheet only for card entry (no raw card data); confirm/settle mirrors the
  web hold/confirm contract.
- Accessibility: accessible roles/labels, adequate touch targets, dynamic-type
  friendly.
