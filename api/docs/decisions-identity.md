# Identity stage 1: decisions not settled by the plan/critique

Forks the docs left open, and the option taken. Everything else follows
`docs/club70-app-api-plan.md` and the identity critique directly.

1. **Member profile at signup.** `POST /signup` creates a Member row linked to
   the new user when no row matches the email (it is where `phone` lives, and
   the plan's `member`-policy onboarding endpoints assume a profile exists
   before payment). When a row already matches, nothing is created: that row
   is a claim candidate, resolved only once the email is verified. `name` is
   split last-word-as-lastName for the Member row. Identity touches the
   members table through a single `MemberDirectory` port + adapter; later
   packages can move it behind a members-context API.

2. **Claim rule.** Claims happen only on a verified email (token verification,
   completed password reset, or provider-verified OAuth email) and only for
   rows with `userId IS NULL`, audited as `MemberClaimed` in the same
   transaction. This deliberately subsumes the narrower "never claim an
   active membership from an unverified email": no unverified email claims
   anything.

3. **Magic link stays admin-only in stage 1.** Opening it to all accounts
   (member recovery) is a stage 2 concern once per-route policies exist;
   stage 1 keeps admin behavior identical.

4. **Admin web session continuity.** Access and refresh tokens ride httpOnly
   cookies (`seventy_access`, `seventy_refresh`, both path `/`), and the auth
   hook transparently rotates the refresh token when the 10-minute access JWT
   expires. The web app has no refresh logic and must not need any; "forced
   re-login" at cutover means once, not every 10 minutes. Path-scoping the
   refresh cookie to `/api/auth/refresh` would break that transparency and is
   not a real security boundary against XSS anyway.

5. **OAuth nonce contract.** Server returns a raw nonce; the client gives the
   platform SDK `sha256(nonce)` (hex), so the ID token's nonce claim carries
   the hash; the client sends the raw nonce back with the token. The server
   hashes once, burns the `auth_tokens` row by that hash and compares it to
   the claim.

6. **Apple refresh token.** Stored AES-256-GCM encrypted with a key derived
   from `JWT_SECRET` (versioned `v1:` format so a dedicated key env var can
   supersede it without migration). If the .p8 signing config is absent, the
   code exchange is skipped with a warning and sign-in still succeeds; only
   identity-token verification requires `APPLE_BUNDLE_ID`.

7. **Session idle window** slides on refresh rotation only (capped at the
   absolute expiry). Access-token validation stamps `lastUsedAt` best-effort
   but does not extend the window; with a 10-minute access TTL the client
   refreshes at least that often while active, which is equivalent.

8. **Cap eviction revokes, never deletes.** Oldest active sessions per
   (userId, client) beyond the cap get `revokedReason = 'evicted'`; rows are
   kept for audit. Cleanup of old revoked rows is a later cron concern.

9. **Admin users API shape.** `/api/admin/users` keeps returning `role`
   (mapped from `staffRole`, `'member'` when null) because the deployed admin
   web UI renders it. Stage 2's principal rewrite owns any shape change.

# Identity stage 2: authorization decisions

Continues the list above; same rule, only the forks the plan and critique left
open.

10. **Two hooks, not a plugin.** `assertRoutePolicy` (`onRoute`) and `authHook`
    (`preHandler`) are added directly to the root instance in `server.ts`,
    before the first route registration. A plugin would encapsulate the hooks
    and miss its siblings, and `fastify-plugin` is not a dependency. Order
    matters for `onRoute` (it only sees routes registered after it), which is
    why the two lines sit above every `register` call.

11. **The static SPA bundle is the single policy exemption.** `@fastify/static`
    generates one route per bundled file and offers no way to declare route
    config; those routes are recognised by the `{ file, rootPath }` config the
    plugin stamps on them and rewritten to `policy: 'public'`, so the request
    hook still sees an explicit declaration. Everything else fails closed.

12. **`config.policy` is a required field of `FastifyContextConfig`.** Any route
    that passes a `config` object must include a policy or it does not compile;
    a route that passes no options object at all compiles but crashes the boot.
    Type checking and the boot assertion cover each other's gap.

13. **The principal costs one query.** `AuthSessionRepository.findByIdWithUser`
    reads the session, its user and the linked `members.id` in a single join,
    replacing the previous session-then-user pair. `IdentityUser.memberId` is
    therefore populated on every user read, which is also what makes the
    cookie-refresh path able to build a principal without an extra round trip.
    Identity reads only the member FK; every other members-table access still
    goes through the `MemberDirectory` port.

14. **`active-member` reuses the bookings context's `PrismaMembershipChecker`.**
    It is already the narrow port for "is this member's membership active", and
    duplicating it in the middleware would mean two answers to one question.
    Tier gating (PRO) stays in the domain that enforces it, as planned.

15. **Cancelling a booking is `member`, not `active-member`.** The plan marks
    self-booking creation `active-member`; cancellation is ownership-checked in
    `bookingService.cancel(bookingId, memberId)` and must keep working after a
    membership lapses, otherwise a lapsed member holds a slot nobody can free.
    The bookings domain already draws exactly this line (`bookCourt` checks
    membership, `cancel` does not); the middleware follows it rather than
    contradicting it.

16. **`AUTH_DISABLED` does not bypass `cron`.** The dev principal satisfies
    every session-backed policy (admin staff role plus a dev member id), but
    cron authenticates a scheduler, not a person; keeping the secret check
    means the dev bypass never becomes a way to trigger jobs by accident.

17. **Sign-out requires a session.** `/signout`, `/signout-all` and `/logout`
    are `authenticated`, so an expired caller gets 401 instead of a courtesy
    200. The admin web already ignores logout failures, and a caller with no
    session has nothing to revoke.

18. **`GET /api/auth/me` returns the principal shape**: `userId`, `email`,
    `emailVerified`, `staffRole`, `memberId`, `client` (was `emailVerifiedAt`).
    The admin web reads only `userId`/`email`; the mobile app needs `memberId`
    to decide whether onboarding is finished.

19. **Magic link now reaches every active account** (member recovery), keeping
    the always-200 response and rate limits. Consuming a link verifies the
    email if it was unverified, which by decision 2 also claims a matching
    staff-created member row; that is the same proof of inbox ownership the
    email-verification path uses.

20. **Link management is `authenticated`, not `member`.** Credentials belong to
    the user account, which exists before a club profile does. `POST
    /api/me/auth-identities/:provider` takes the same verified ID token and
    single-use nonce as sign-in, but resolves the account from the principal:
    a provider account already owned by another user is refused, never moved
    (`decideLinkToAccount`), and unlinking the last remaining credential is
    refused (`decideUnlink`). Both decisions are pure domain functions.

21. **Member Stripe routes are new, not moved.** `/api/me/checkout` and
    `/api/me/billing-portal` derive the member from the principal; the
    body-driven `/api/stripe/*` routes stay admin-only. Package C replaces both
    flows, but the IDOR gate lands now.

# Identity stage 3: review-round fixes

Security/correctness fixes applied after the stage-1/2 review. Each closes a
confirmed defect; the tests named guard against regression.

22. **Magic-link redirect allowlist is exact-match, not prefix-match.**
    `isAllowedRedirectTo` now parses `redirectTo` with `new URL()` and matches
    custom schemes by protocol (`seventy:`, `exp:`) and http(s) targets by
    scheme + exact hostname (any port), and rejects URLs carrying userinfo.
    The old `startsWith` check let `https://auth.expo.io.attacker.tld` and
    `https://auth.expo.io@attacker.tld` through and 302'd the session tokens to
    the attacker's host. Env var renamed `MOBILE_AUTH_REDIRECT_TARGETS` and
    documented in `.env.example`.

23. **Linking a provider requires the account's email to be verified.**
    `decideLinkToAccount` takes `accountEmailVerified` (from the principal) and
    rejects (`account_email_unverified`, 403) otherwise, so a squatter cannot
    pre-plant their own identity on an unverified account ahead of the real
    owner. And the pre-hijack `link` branch now purges **every** pre-existing
    AuthIdentity (`deleteAllForUser`) alongside the password, not just the
    password — the whole pre-verification credential set is untrusted. The new
    verified identity is created after the purge, so it survives.

24. **`decideLinkToAccount` gained a distinct `provider_already_linked`
    reason** (409) for "this account already has an identity for that provider",
    separate from `linked_to_other_account`; the old shared code told the user
    their provider account belonged to someone else when it belonged to nobody.

25. **`trustProxy: true`.** The API runs behind a TLS-terminating proxy (Caddy /
    App Runner), so without it `req.ip` was the proxy address: one global
    rate-limit bucket and a useless `auth_sessions.ip` audit column. Options
    live in `src/lib/server-options.ts` with a regression test.

26. **Cookie refresh is single-flight; the grace path retries instead of
    401-ing.** `SessionService.refresh` coalesces concurrent refreshes of the
    same token onto one rotation (in-process map keyed by presented hash), so
    parallel admin-web XHRs after the 10-minute access TTL all receive the same
    new token pair instead of the browser keeping an orphaned intermediate
    token. The grace-window path re-reads and retries a lost guarded rotate
    (bounded) rather than throwing `InvalidTokenError` on a healthy session.

27. **Member claiming withholds billing-carrying rows without proven account
    control.** `decideMemberClaim` refuses to claim a staff-created row that
    carries a Stripe customer or a membership unless the auth path proves the
    caller controls the account (magic link, provider OAuth, completed password
    reset). A bare email-verification click proves the inbox got the token, not
    that whoever set the (possibly attacker's) password owns the account, so it
    no longer hands a paying member's profile + billing to a squatter. Ordinary
    no-billing profiles still auto-claim on verification. This corrects the
    stage-1 decision 2 deviation from critique edge case 22.

28. **`POST /api/admin/users` uses the shared `emailSchema`** (trim +
    lowercase), and `UserRepository.create`/`findByEmail` normalize defensively,
    so a mixed-case admin address can no longer be written unreachable or create
    a case-only duplicate row. The conflict now returns 409.

29. **`resetPassword` revokes sessions inside the transaction.** The revoke
    moved into `uow.execute` with `{ tx }`, so a failed revoke rolls the whole
    reset back (and stays retryable) instead of leaving the password changed
    while the attacker's pre-reset sessions keep authenticating.

30. **A lost member-claim race is a benign no-op.** `MemberDirectory.claim`
    returns a boolean instead of throwing when its guarded update matches zero
    rows; `claimIfEligible` skips the audit event and returns
    `{ claimedMemberId: null }`, so a concurrent claim can no longer 500 the
    enclosing verification/sign-in transaction.

## Deferred follow-ups (recorded, not yet done)

- **Signup email-enumeration.** `POST /api/auth/signup` returns 409
  `EMAIL_IN_USE` for a registered address, a membership oracle that the
  always-200 `/password/forgot` and `/magic-link` deliberately avoid. Closing
  it means deferring account + session creation until email confirmation (a
  signup-flow redesign, CWE-204, inherent to self-service signup with immediate
  session issuance), so it is left for the onboarding-flow work, not patched
  here.

- **Mobile magic-link token shape.** `GET /api/auth/verify` now returns a
  10-minute access token plus a `refreshToken` in the redirect (was a multi-day
  session JWT). The in-repo Expo client (`mobile/`, untouched on this branch)
  stores only `token` and has no `/api/auth/refresh` call, so its session dies
  after 10 minutes. Fix belongs in the mobile client (persist `refreshToken`,
  refresh on 401 with a single-flight guard); tracked with the mobile-client
  update, not worked around server-side.

- **Refresh token in the redirect query.** Even with the exact-match allowlist
  (fix 22), handing the refresh token back as a query parameter is only as safe
  as the app's custom scheme. The stronger shape is a one-time exchange code the
  app POSTs over TLS; it is coupled to the mobile-client change above and lands
  with it.

- **Per-account rate limiting.** `trustProxy` (fix 25) restores per-client-IP
  limits, but critique edge case 7 also wants an email-keyed limiter on
  `/signin`, `/password/forgot` and `/magic-link` to throttle a single account
  from many IPs. Doing it correctly needs the limiter to read the parsed body
  (ordering work with @fastify/rate-limit's onRequest hook); deferred as a
  hardening on top of the confirmed IP fix.

- **Staff/member notification on `MemberClaimed`.** Fix 27 closes the takeover;
  critique edge case 22 also asks for a notification when a row is claimed. It
  needs a new communications template + wiring and is deferred as a compensating
  control, with the in-transaction audit event already emitted in the meantime.
