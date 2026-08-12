# Club70 member web client: plan

Building the member-facing web app for the Club70 designs (the same six flows the
backend serves). Decisions locked with the owner:

- **Responsive**: fully responsive desktop. The Figma is phone-only; desktop
  layouts are adapted (sidebar nav replaces the bottom tab bar, multi-column
  where it helps). Mobile viewport stays 1:1 with the Figma.
- **Placement**: a new **`member-web/`** SPA in the monorepo, separate from the
  admin `web/`. Its own shell, auth, nav, and design language.
- **Auth**: full parity now (email/password + magic-link + Google + Apple),
  reusing the self-built backend identity system (Package A). No third-party IdP.
- **Design language**: the member app gets its OWN theme derived from the Figma
  (consumer brand: dark green / olive, accent lime), NOT the Octahedron admin
  system. A small purpose-built member UI kit.

## Stack (mirror what the repo already proves)

- Vite + React 19 + React Router v7 (same as `web/`).
- `@tanstack/react-query` for data (mobile already proves this pattern; the many
  `/api/me/*`, `/api/reservations`, `/api/clubs` endpoints need it).
- `@stripe/stripe-js` + `@stripe/react-stripe-js` (Payment Element) for checkout,
  consuming the client secrets the billing API already returns.
- Member design tokens + primitives pulled from the Figma variables, in
  `member-web/src/theme` and `member-web/src/components`.

## Auth on web (the one backend touch-point)

Web is a browser, so sessions ride **httpOnly cookies** (never tokens in JS),
same-origin, exactly like the admin `web/` app does today. This needs a bounded
backend addition (Package Wprep):

Landed (see `api/docs/decisions-web-auth.md` for the full decision log):

- A **`member_web` client type**: cookie transport identical to the admin app
  (httpOnly, Secure in prod, SameSite=Lax, both cookies at path `/`) with
  14-day idle / 90-day absolute TTLs, 10 sessions per user.
- **Client selection is the `X-Client-Type: web` request header** on
  `POST /api/auth/signup`, `/signin`, `/oauth/google`, `/oauth/apple` and
  `/magic-link`. With it, those endpoints set session cookies and return
  `{ user, accessTokenExpiresAt }` with no tokens in the body; without it (or
  with `mobile`) the bearer token pair keeps flowing for the native app.
- **Magic link on web**: send with `X-Client-Type: web` and no `redirectTo`;
  the emailed link carries `client=member_web` and `GET /api/auth/verify`
  sets cookies, then 302s to `/` (errors 302 to `/sign-in?error=...`, codes
  `missing_token` / `invalid_token` / `unknown`). Works for every active
  account, no admin role involved.
- **Apple web audience**: `APPLE_WEB_SERVICES_ID` joins the bundle ID as an
  accepted `aud`, so Sign in with Apple JS tokens verify. Google web client
  ID is appended to the existing `GOOGLE_OAUTH_CLIENT_IDS` allowlist. Owner
  provides the real credentials; endpoints return 501 NOT_CONFIGURED without.

Frontend contract (same as admin cookie auth): every request uses
`credentials: 'include'`; auth-issuing POSTs add `X-Client-Type: web`; social
sign-in gets an ID token from the Google/Apple JS SDK (given `sha256(nonce)`
in hex, nonce from `POST /api/auth/oauth/nonce`) and POSTs it back with the
raw nonce to the existing verify endpoints; session state comes from
`GET /api/auth/me` (the `Principal`, `data: null` when signed out). Access
tokens rotate transparently server-side; the client needs no refresh logic.

## Deploy (Package Wprep owns this)

Two bundles from the one API container, same-origin so cookies need no CORS:

- `member-web/` built and served at `/` (the primary consumer app).
- Admin `web/` relocated to `/admin` (vite `base: '/admin/'` + router
  `basename="/admin"`; magic-link redirects follow).
- API Dockerfile builds both bundles into `public/` and `public/admin/`; a
  history-fallback per prefix (`src/lib/static-bundles.ts`). The member stage
  is guarded so the image builds before `member-web/` exists; once it does,
  it must build with `npm ci && npx vite build` emitting `dist/`, with a
  committed `package-lock.json`, calling the API via relative `/api` paths.
  Dev: each app's Vite proxies `/api` to `:3001`.

## Packages

- **Wprep** Backend auth-for-web + deploy: `member_web` cookie sessions, Apple web
  audience, OAuth web config, Dockerfile/serving for two bundles, CORS/dev proxy.
  Owns `api/` + root deploy files.
- **F0** Foundation: scaffold `member-web/`, design tokens + core primitives from
  the Figma, responsive app shell (desktop sidebar / mobile bottom-tab), routing,
  auth context (cookie session, login/signup/OAuth/magic-link/verify screens),
  react-query API client, Stripe provider, env/build. Owns `member-web/` only.
- Flow packages (depend on F0; each pulls its Figma screens for fidelity via the
  Figma MCP, builds responsive pages, wires backend endpoints):
  - **W1** Onboarding + membership: plan selection, Stripe checkout, ID
    verification upload, onboarding-resume gating.
  - **W2** Home: aggregated feed, greeting, quick-book, upcoming reservations,
    inline invitation accept/decline, spotlight events, empty state, QR entry.
  - **W3** Booking: resource types, availability calendar, multi-slot select,
    invite players (member + club search), checkout/pay, confirmation.
  - **W4** Reservations: detail, accept/decline invite, edit/reschedule (delta +
    pay/refund), cancel, withdraw.
  - **W5** Clubs: list, create wizard, detail, members roster, invites + link/QR,
    activity feed.
  - **W6** Account: profile, avatar, stats, member QR card, notification
    preferences, billing history, payment methods, membership change, delete.

## Dependencies

Wprep and F0 run concurrently (different dirs; F0 builds against the documented
cookie contract). Flow packages start after F0. Each flow gets an adversarial
review gate (correctness, design fidelity, a11y, client-side authz/data-scoping)
before the next, same discipline as the backend.

## Cross-cutting frontend standards (set by F0, enforced in review)

- Every data mutation is a react-query mutation with optimistic/rollback where the
  design implies instant feedback (toggles, accept/decline); loading + error +
  empty states for every screen (the Figma omits them; we define them).
- Accessibility: semantic landmarks, keyboard nav, focus management in modals,
  labelled controls, adequate contrast in the dark theme.
- No secrets or tokens in JS; Stripe via Elements (PCI stays SAQ A on web too).
- Responsive: a shared max-width app frame with breakpoints; the bottom tab bar
  collapses to a desktop sidebar; wide surfaces (booking grid, billing history)
  get room on desktop but never require it.
