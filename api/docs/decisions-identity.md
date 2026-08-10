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
