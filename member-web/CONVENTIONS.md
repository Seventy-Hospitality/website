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

## Quality bar

- `npm run build` (type-check + bundle), `npm run lint`, and `npm test`
  all clean before review.
- Vitest + Testing Library for logic-bearing pieces (guards, mappers,
  tricky components); test user-visible behavior, not implementation.
- No em dashes in copy, comments, or commits. No AI co-author trailers in
  commits.
