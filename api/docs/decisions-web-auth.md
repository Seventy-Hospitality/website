# Web auth (Package Wprep): decisions

Backend auth-for-web plus deploy wiring for the Club70 member web client
(`member-web/`, Package F0). Same rule as `decisions-identity.md`: only the
forks the plan left open, and the option taken.

1. **`member_web` is a third client, not a flag on an existing one.** The
   `Client` union gains `member_web` with cookie transport identical to
   `admin_web` (httpOnly, Secure in production, SameSite=Lax, both cookies at
   path `/`, see decision 4 in `decisions-identity.md` for why the refresh
   cookie is not path-scoped) and its own session policy: **14-day idle,
   90-day absolute, 10 sessions per user**. Shorter than the native app's
   60/180 because a browser is likelier to be shared or public than a phone;
   long enough that a weekly visitor never re-authenticates. No schema
   change: `auth_sessions.client` is a plain string column.

2. **Client selection is the `X-Client-Type` request header**, not a body
   field. `web` selects `member_web` (cookies set, token-free body), `mobile`
   selects `member_mobile` (bearer token pair in the body), and **no header
   means mobile** because the deployed native app predates the header and
   must keep working unchanged. Any other value is a 400. A header beats a
   Zod body field because the signal is transport metadata, orthogonal to
   the five request schemas it would otherwise be duplicated into, and the
   browser preflight + CORS allowlist already gate cross-origin use of a
   custom header. Applies to `POST /signup`, `/signin`, `/oauth/google`,
   `/oauth/apple`, and `/magic-link`.

3. **Web session responses carry no tokens.** For `member_web`,
   signup/signin/oauth call `setSessionCookies` and return
   `{ user, accessTokenExpiresAt }`, the same shape as the cookie branch of
   `/refresh`. `/refresh`, `/signout`, `/logout`, `/signout-all` and
   `/auth/me` were already client-agnostic (cookie vs bearer is decided per
   request, the session's client rides in the row) and needed no change,
   only tests.

4. **The magic link itself encodes its flow.** `GET /verify` is a bare
   browser navigation from an email and carries no headers, so `/magic-link`
   mints the marker into the link: `redirectTo` (native deep link, body
   tokens in the 302), `client=member_web` (member web: cookies, land on the
   member app at `/`), or neither (admin web: cookies, land on
   `/admin/members`). The two markers are mutually exclusive, at mint and at
   verify. A tampered `client` value can only change the transport/TTL of
   the clicker's own session, never privileges: the ladder reads `staffRole`
   from the user row, not the client. Magic link already reaches every
   active account (decision 19), so the web flow needs no admin role.

5. **Authorization is unchanged by transport.** A `member_web` session
   passes `member`/`active-member` through its `memberId` and fails
   `staff`/`admin` unless the user row carries a staff role, exactly like
   `member_mobile`; sharing the cookie transport with `admin_web` shares
   nothing of the ladder (regression-tested in `middleware/auth.spec.ts`).

6. **Apple web audience is an allowlist, mirroring Google.**
   `AppleIdTokenVerifier` takes the list of accepted `aud` values, built in
   the container from `APPLE_BUNDLE_ID` (native) and the new
   `APPLE_WEB_SERVICES_ID` (Sign in with Apple JS mints tokens with the
   services ID as `aud`). Either alone works; with neither set the endpoint
   keeps returning 501 NOT_CONFIGURED. Google needed no code change:
   `GOOGLE_OAUTH_CLIENT_IDS` was already a comma-separated aud allowlist;
   the member web app's Google client ID is simply appended there.

7. **Serving layout: two same-origin bundles from one container.** The
   member app (primary) is built into `public/` and served at `/`; the admin
   app moves under `public/admin/` and `/admin`. `registerStaticBundles`
   (`src/lib/static-bundles.ts`) registers one `@fastify/static` root with a
   prefix-aware SPA fallback: `/api/*` misses stay JSON 404s, `/admin` and
   `/admin/*` fall back to `admin/index.html`, everything else to the member
   `index.html`. Prefix matching is `/admin` exact or `/admin/`, so a member
   route like `/administration` is not swallowed. Each bundle is optional
   (checked at boot): the API boots and tests pass before F0 lands, and an
   API-only checkout behaves as before. Same origin means cookies need no
   CORS.

8. **The admin app owns base path `/admin` at build time.** `web/`:
   `vite.config.ts` gains `base: '/admin/'` and the `BrowserRouter` gains
   `basename="/admin"`; in-app navigation is all router-relative and API
   calls are origin-absolute (`/api/...`), so nothing else moves. The admin
   magic-link redirects follow: `/admin/members` on success,
   `/admin/sign-in?error=...` on failure. `WEB_URL` stays the bare web
   origin (member-facing email links `/verify-email`, `/reset-password`
   resolve against it; the admin paths are derived by appending `/admin`).

9. **The Dockerfile builds both bundles and tolerates a missing
   `member-web/`.** A `member-web-build` stage mirrors the admin one
   (lockfile layer, `npm ci`, `npx vite build`); each COPY uses a `[b]`
   glob (`COPY member-we[b] ...`), which BuildKit treats as a no-match
   no-op instead of an error while the directory does not exist, and the
   RUN guards then leave an empty `dist/`. Production copies
   `member-web/dist` to `public/` and `web/dist` to `public/admin/`. F0's
   contract: `member-web/` must build with `npm ci && npx vite build`
   emitting `dist/`, with a committed `package-lock.json`, and call the API
   by relative `/api` paths (no `VITE_API_URL` needed same-origin).
