# member-web conventions

The standards every flow package (W1 onboarding, W2 home, W3 booking,
W4 reservations, W5 clubs, W6 account) follows. The foundation (F0) set
these patterns; review gates enforce them.

## Route ownership

`src/App.tsx` is the single route map. Each flow replaces its labelled
`PlaceholderPage` and owns its subtree:

| Package | Routes | Notes |
| --- | --- | --- |
| W1 | `/onboarding/*` | full-screen, outside the tab shell; gate on `useSession().needsOnboarding` / `emailVerified` |
| W2 | `/` | home feed; owns the greeting + QR header slots |
| W3 | `/reserve/*` | booking wizard |
| W4 | `/reservations/:reservationId` | detail, edit, cancel |
| W5 | `/clubs`, `/clubs/new`, `/clubs/:clubId/*` | |
| W6 | `/account/*` | keeps the sign-out action |

Screens that belong to another package stay as labelled placeholders; never
half-build a neighbor's page.

## Data: react-query for everything

- All server state flows through `@tanstack/react-query` and the typed
  client in `src/lib/api.ts`. No ad hoc `fetch` in components.
- Extend the `api` object with your endpoint group (comment-headed, typed
  inputs and outputs). Everything rides the shared pipeline: cookies,
  `X-Client-Type` on auth calls, 401 refresh-retry, `ApiError`.
- Query keys are arrays rooted in the domain: `['clubs']`,
  `['clubs', clubId]`, `['reservations', { day }]`. Invalidate by prefix.
- Every mutation is a `useMutation`. When the design implies instant
  feedback (toggles, accept/decline), do optimistic updates in `onMutate`
  with rollback in `onError`; otherwise invalidate in `onSuccess`.
- The session query belongs to the foundation: read it through
  `useSession()`, refresh it with `refreshSession()` after anything that
  changes the Principal (auth, onboarding completion, email verification).

## Shared reservation surface (set by W3)

W2 (home) and W4 (reservation detail) render the same serialized
reservation shapes the booking flow consumes. Reuse, do not redefine:

- Types: `Reservation`, `ReservationParticipant`, `AvailabilityDay`,
  `ResourceTypeSummary`, `MemberSearchResult`, club summaries, in the
  booking section of `src/lib/api.ts`.
- Slot math + labels: `src/lib/booking.ts` (venue wall-clock "HH:MM"
  helpers, `formatTimeRangeCompact`, `formatDuration`, `bookingRefLabel`,
  date-key helpers). Invite chips: `src/lib/invites.ts`.
- Components: `ReservationCard` and `ResourceTypeIcon` from
  `src/components` (the checkout/confirmation cards; home cards and the
  W4 detail header are the same surface).
- Query keys: `['reservations', id]` (`reservationQuery` in
  `src/pages/reserve/booking-data.ts`), `['availability', typeCode,
  date]`, `['resource-types']`, `['clubs']`. Booking mutations invalidate
  the `['reservations']`, `['home']`, and `['availability', typeCode]`
  prefixes; do the same for reservation-changing mutations in W4.
- Invitation responses (W4; W2 home renders the same inline actions):
  `useRespondToReservation()` in `src/lib/reservation-respond.ts` is THE
  respond mutation: optimistic flip of the viewer's row in the
  `['reservations', id]` cache with rollback, conflict re-fetch, and the
  standard invalidation. It also rewrites the `['home']` feed cache
  (`applyResponseToHome`: accept moves the invitation card into the
  upcoming list, decline drops it) with the same snapshot rollback. Policy
  mirrors (participant transitions, the cancellation refund tiers,
  reschedule delta/dirty helpers) live in
  `src/lib/reservation-policy.ts`; the server response stays authoritative.
- Home feed (W2): `homeQuery` in `src/pages/home/home-data.ts` owns the
  `['home']` key (GET `/api/me/home?tz=<browser IANA zone>`); mutations
  keep invalidating the `['home']` prefix as above. Club invitations
  respond through `useRespondToClubInvitation()` in the same module
  (optimistic removal, rollback, invalidates `['home']` + `['clubs']`).
  Beware: a card whose respond action unmounts it optimistically must run
  its outcome toasts from a mutation owned by the PAGE, not the card
  (mutate-time callbacks are dropped for unmounted callers).

## Clubs surface (set by W5)

- Query keys: `['clubs']` (list; `myClubsQuery` in
  `src/pages/reserve/booking-data.ts`), `['clubs', id]` (detail with the
  backend's `permissions` flags), `['clubs', id, 'members']`
  (`clubRosterQuery`), `['clubs', id, 'activity']`, `['club-invitations']`
  (the viewer's pending invitations). Club mutations invalidate by these
  prefixes; render club actions from the `permissions` flags, never from
  `myRole`.
- `useRespondToClubInvitation()` (`src/pages/home/home-data.ts`) is THE
  club-invite respond mutation for every surface (home cards and the
  clubs tab): optimistic removal from `['home']` AND
  `['club-invitations']` with rollback, then invalidation of both plus
  `['clubs']`.
- The invite pickers ride the member directory:
  `api.searchMembers('')` serves the default alphabetical page (caller
  excluded server-side); `clubDirectoryQuery` in
  `src/pages/clubs/clubs-data.ts` is the picker feed, and
  `ClubMemberPicker` reuses `src/lib/invites.ts` selection logic.
- Club share links: the raw token is returned once by
  `POST /api/clubs/:id/invite-link`; `clubJoinUrl` (clubs-lib) builds the
  `/clubs/join?token=` URL that both the QR (via `src/lib/qr.ts`) and the
  Copy/Share actions use. `useClubInviteLink` keeps the minted URL in the
  `['clubs', id, 'invite-link']` cache entry so every surface shares one
  link and a rotate replaces it everywhere. Backend gaps:
  `docs/w5-clubs-notes.md`.

## Member QR card (set by W2)

`MemberQrSheet` in `src/components` is THE membership card overlay
(Figma account/member-card 107:9461): W2 opens it from the home header's
QR button and W6's account "View membership card" must reuse it, not
rebuild it. Props: `open`, `onClose`, `memberName`, `memberNumber`. It
fetches `GET /api/me/qr` itself (query `['member-qr']`, only while open,
never cached across opens) and re-requests before the token's 60s TTL
lapses; the QR is drawn by `src/lib/qr.ts` (`qrcode-generator`, zero
deps) with the member number as the text fallback for failed scans.

## Account surface (set by W6)

- The `['membership']` query (onboarding-data.ts) reads GET
  /api/me/billing and now types the FULL `BillingOverview` (membership +
  default payment method + ledger months): the onboarding gate reads its
  `membership` half, the billing page reads all of it, one key, no drift.
  Month transactions: `['billing', 'transactions', month]`
  (`billingTransactionsQuery` in `src/pages/account/account-data.ts`),
  fetched lazily on first expand. Other keys: `['profile']`,
  `['preferences']`, `['auth-identities']`.
- Invalidation: money-state mutations (plan change, cancel membership,
  set-default card) invalidate `['membership']` + the `['billing']`
  prefix (+ `['profile']`, `['home']`); profile edits (name, avatar)
  patch `['profile']` and invalidate `['home']` + `['clubs']`.
- Plan-change policy mirror: `src/lib/membership-change.ts`
  (`isPlanUpgrade` matches the backend exactly; upgrades immediate with
  proration, downgrades at period end). The server response stays
  authoritative; the mirror only drives preview copy.
- The preference toggles save independently: each PUT carries ONLY its
  key, optimistic with per-key rollback, so concurrent toggles can never
  clobber each other (`AppPreferencesPage`; `Switch` in the kit is the
  accessible toggle control).
- Account deletion is step-up gated per the backend contract; see
  `docs/w6-account-notes.md` for the proof choice and blocked-state
  handling.

## Loading / error / empty states are first-class

The Figma omits them; we do not. Every screen ships all three:

- **Loading**: `Skeleton` blocks mirroring the final layout for initial
  loads (mark the region `aria-busy`); `Spinner` (or `Button loading`) for
  in-flight actions. Full-screen only via `FullScreenLoader`.
- **Error**: inline retryable state for query failures. Wrap it in the
  standard pattern: short message + a "Try again" button calling
  `refetch()`. Never a blank screen, never a raw error string from the API.
- **Empty**: `EmptyState` with an icon, one-line title, one supporting
  sentence, and a single call to action, per the home banner treatment.

## Forms

- `react-hook-form` + `zod` via `useZodForm(schema)` (`src/lib/forms.ts`);
  shared field schemas live there too and mirror the backend's validation.
- Render fields with `FormField` + `Input`/`PasswordInput`: it wires label,
  error, and hint accessibly (label `for`, `aria-describedby`,
  `aria-invalid`). Labels render uppercase per the Figma.
- Server-side validation failures map onto fields when the code is
  specific (e.g. `EMAIL_IN_USE` -> email field) and onto a form-level
  `root` error rendered as a `role="alert"` inline alert otherwise.

## Toasts

`useToast()` (provider is already mounted). Success toasts confirm
mutations whose result is not visible where the user is looking; error
toasts surface unexpected failures. Form validation stays inline, never in
a toast.

## Theme and styling

- CSS Modules co-located with components; class composition over
  overrides.
- Style with the custom properties from `src/theme/tokens.css` only; no
  hard-coded colors, radii, or font sizes. JS-side values (Stripe
  appearance, SVG) come from `src/theme/tokens.ts`.
- The brand is a single dark theme (`color-scheme: dark`); there is no
  light mode.
- Type: Manrope (`--font-display`) for headings, Inter (`--font-body`) for
  everything else. h1..h3 defaults are set globally in `index.css`.

## Responsive

- Mobile-first, 1:1 with the Figma phone frames; desktop adapts.
- Breakpoints (min-width, use literally in media queries; documented in
  `tokens.ts`): 480 / 768 / 1024. The shell switches bottom tab bar ->
  sidebar at 768.
- Pages render inside the shell's centered column (`--content-max`,
  720px). Wide surfaces (booking grid, billing tables) may widen on
  desktop with their own media query but must never require it.

## Accessibility baseline

- Semantic landmarks (`nav`, `main`, `header`), one `h1` per page via
  `PageHeader`.
- Every control labelled: `FormField` for inputs, `aria-label` for
  icon-only buttons.
- Keyboard: everything reachable and operable; focus-visible ring is
  global (accent, 2px offset). Modals use `Sheet` (native `<dialog>`:
  focus trap, Escape, inert background). Composite widgets manage roving
  tabindex (`SegmentedControl` is the reference).
- Announcements: toasts are `aria-live`; loading regions use `role=status`
  / `aria-busy`.
- Contrast: token pairs are chosen for AA on the dark surfaces (muted text
  and danger included); do not invent new color combinations.

## Payments

Stripe Elements only (`StripeProvider` + Payment Element with the shared
`stripeAppearance`); client secrets come from the billing API. No card
data ever touches our code (SAQ A).

Booking checkout holds: every hold-affecting path goes through the wizard's
hold session (`src/pages/reserve/hold-session.ts`). Its two invariants:
out-of-order create responses never cancel the live hold, and a hold whose
payment was submitted is never client-cancelled (backend cancel of a paid
hold refunds at the policy percent, 0% near start time). While that payment
lock is held the wizard chrome (Back/Close) is disabled.

## Quality bar

- `npm run build` (type-check + bundle), `npm run lint`, and `npm test`
  all clean before review.
- Vitest + Testing Library for logic-bearing pieces (guards, mappers,
  tricky components); test user-visible behavior, not implementation.
- No em dashes in copy, comments, or commits. No AI co-author trailers in
  commits.
