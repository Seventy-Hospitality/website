# member-web

The Club70 member-facing web app: a responsive React SPA with its own member
design language (dark green / olive brand, lime accent) derived from the
member app Figma. Separate from the admin `web/` app in every way except the
backend it talks to.

Read `CONVENTIONS.md` before building a flow package on top of this
foundation.

## Stack

- Vite + React 19 + TypeScript + React Router v7
- `@tanstack/react-query` for all server data
- `react-hook-form` + `zod` for forms
- `@stripe/stripe-js` + `@stripe/react-stripe-js` (Payment Element) for checkout
- CSS Modules + design tokens (`src/theme/tokens.css`); no CSS framework
- Vitest + Testing Library

## Development

```bash
# 1. Run the API (terminal 1)
cd api && npm run dev            # http://localhost:3001

# 2. Run member-web (terminal 2)
cd member-web && npm install
npm run dev                      # http://localhost:5174
```

The dev server proxies `/api/*` to `http://127.0.0.1:3001`
(see `vite.config.ts`), so cookie auth is same-origin in dev exactly as in
production. Admin `web/` owns :5173; member-web owns :5174 (Vite picks the
next free port if it is taken).

### Environment

Copy `.env.example` to `.env` as needed. Everything is optional:

| Variable | Purpose | When empty |
| --- | --- | --- |
| `VITE_API_URL` | API origin | same-origin (dev proxy / prod) |
| `VITE_GOOGLE_CLIENT_ID` | Google Identity Services web client | Google button disabled with a "not configured" note |
| `VITE_APPLE_CLIENT_ID` | Sign in with Apple services ID | Apple button disabled with a "not configured" note |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Stripe Elements | checkout surfaces show "payments not configured" |

### Commands

```bash
npm run dev          # dev server on :5174
npm run build        # type-check (tsc -b) + production bundle into dist/
npm run lint         # eslint
npm test             # vitest run
npm run test:watch   # vitest watch
```

## Auth model (cookie sessions)

Sessions live in httpOnly cookies; JS never sees a token.

- Every request goes through `src/lib/api.ts` with `credentials: 'include'`.
- Calls under `/api/auth/` also send `X-Client-Type: web`, which tells the
  backend to issue cookies instead of body tokens.
- Session truth is `GET /api/auth/me` (the `Principal`), cached by
  react-query under `SESSION_QUERY_KEY` and exposed via `useSession()`
  (`src/lib/session-context.ts`).
- On a 401 the client refreshes once (`POST /api/auth/refresh`, single-flight)
  and retries; a second 401 surfaces as `ApiError`.
- Route guards: `MemberAuthGuard` (protected app, redirects to `/sign-in`
  preserving the attempted location) and `AnonymousOnly` (auth screens).

Auth surfaces built here: start/splash, sign up, sign in, Google + Apple
(nonce-bound ID token flow), magic link request + `/auth/callback` landing,
forgot/reset password, email verification prompt/resend, sign out.

## Production build

`npm run build` emits a static `dist/` served by the API container at `/`
(package Wprep owns that serving). The bundle is fully self-contained; the
only runtime origin it needs is its own (plus Google/Apple/Stripe scripts
when those features are configured).

## Layout

```
src/
├── main.tsx            # providers: react-query, toasts, session
├── App.tsx             # route map (flow ownership noted inline)
├── theme/              # tokens.css (custom properties) + tokens.ts (typed)
├── components/         # member UI kit (Button, FormField, Sheet, Toast, ...)
├── app/                # AppShell (responsive nav), PageHeader, BrandMark
├── lib/                # api client, session, forms, oauth, stripe, env
├── pages/              # route components; one folder per flow area
└── test/               # vitest setup
```
