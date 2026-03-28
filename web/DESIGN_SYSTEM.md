# Design System

Typography, spacing, color, and component guidelines for the Seventy web application.
Built on the [octahedron](../octahedron) component library.

## Setup

```tsx
// app/layout.tsx
import 'octahedron/tokens.css';
import 'octahedron/brand.css';
```

Components are imported directly:

```tsx
import { DataTable, ControlButton, Input, Tag } from 'octahedron';
```

Styling uses **CSS Modules** co-located with components. Use octahedron's design tokens (CSS custom properties) for all spacing, color, and typography values.

---

## Typography

### Type Scale

| Token | Size | Use |
|-------|------|-----|
| `--gs-font-size-body` | 13px | Default for everything — minimum font size |
| `--gs-font-size-title` | 18px | Page/modal/section titles |

### Usage Rules

#### 13px (`body`) - Default for everything:

This is the **minimum font size** in the application. All text uses this size unless it needs to be larger.

- Form field labels (use `--gs-muted` color for hierarchy)
- All content, values, descriptions, annotations
- Input field text (including compact inputs)
- Inline annotations, badges, chips, tags
- Table column headers
- Section titles in panels
- Empty state messages (use `--gs-muted` + italic)

**Use color and weight — not size — to create hierarchy** at body scale. Muted text (`--gs-muted`) for secondary content, medium weight for labels, regular weight for values.

#### 18px (`title`) - Top-level headings:

- Page titles
- Modal titles
- Major section headers (use `--gs-font-weight-semibold`)

## Font Weights

| Token | Value | Use |
|-------|-------|-----|
| `--gs-font-weight-regular` | 400 | Body text |
| `--gs-font-weight-medium` | 500 | Labels, emphasis |
| `--gs-font-weight-semibold` | 600 | Titles, headings |

## Colors

### Text Colors

| Token | Use |
|-------|-----|
| `--gs-text` | Primary text |
| `--gs-muted` | Secondary text, labels, hints |
| `--gs-link` | Link text |

### Semantic Colors

| Token | Use |
|-------|-----|
| `--gs-success` | Success states, active memberships |
| `--gs-warning` | Warning states, past_due memberships |
| `--gs-danger` | Error/danger states, canceled memberships |
| `--gs-info` | Informational states |
| `--gs-accent` | Brand accent |

Each semantic color has a corresponding `-bg` variant for backgrounds.

## Spacing

### Scale (4px base)

| Token | Value | Use |
|-------|-------|-----|
| `--gs-space-1` | 4px | Badge padding, tight gaps |
| `--gs-space-2` | 8px | Icon-text gaps, control gaps |
| `--gs-space-3` | 12px | Content gaps, section internal spacing |
| `--gs-space-4` | 16px | Section padding, page gutters |
| `--gs-space-5` | 24px | Section gaps |
| `--gs-space-6` | 32px | Empty states, major breaks |

### Spacing Model

```
PROPERTY        USE FOR                         NEVER USE FOR
─────────────────────────────────────────────────────────────
gap             Sibling spacing                 —
padding         Internal space within element   —
margin          Self-positioning only           Sibling spacing
```

**The rule:** If you're adding `margin-bottom` to create space before the next sibling, you're doing it wrong. Add `gap` to the parent instead.

```css
/* Correct - parent owns spacing */
.container {
  display: flex;
  flex-direction: column;
  gap: var(--gs-space-3);
}

/* Wrong - child margins for sibling spacing */
.title {
  margin-bottom: var(--gs-space-3);
}
```

**Valid margin uses:**
- `margin: 0 auto` for centering
- Negative margins for alignment corrections
- `margin-top: auto` to push element to bottom of flex container

### Decision Tree

```
What are you spacing?
│
├─ Between page sections? → --gs-space-5 or --gs-space-6
├─ Container padding? → --gs-space-4
├─ Content items in list? → --gs-space-3
├─ Tight control groups? → --gs-space-2
├─ Icon-to-text gap? → --gs-space-2
└─ Badge internal? → --gs-space-1
```

## Z-Index Scale

| Token | Value | Use For |
|-------|-------|---------|
| `--gs-z-base` | 1 | Floating elements within containers |
| `--gs-z-sticky` | 10 | Sticky headers/footers |
| `--gs-z-header` | 20 | App header/navbar |
| `--gs-z-dropdown` | 30 | Popovers, dropdowns |
| `--gs-z-overlay` | 100 | Modal/drawer backdrop |
| `--gs-z-modal` | 101 | Modal/drawer content |

## Border Radius

Use `--gs-control-radius` (6px) for standard UI controls. Use `--gs-radius-sm` (3px) for small elements (badges, slider tracks). Never use spacing tokens for border-radius.

## Control Sizing

| Token | Value |
|-------|-------|
| `--gs-control-height` | 28px |
| `--gs-control-radius` | 6px |
| `--gs-control-padding` | 4px |
| `--gs-control-gap` | 8px |

## Icons

| Token | Value |
|-------|-------|
| `--gs-icon-size` | 14px |
| `--gs-icon-slot-size` | 18px |

## Form Fields

Use a `FormField` wrapper for all form fields. This ensures consistent layout and accessibility.

### Pattern

```tsx
<FormField label="Email">
  {(id) => (
    <Input
      id={id}
      value={email}
      onValueChange={setEmail}
    />
  )}
</FormField>
```

### Why This Pattern

1. **Accessibility**: The render prop provides an auto-generated ID that connects the `<label htmlFor>` to the input's `id` attribute
2. **No hover cascade**: Uses sibling-based structure (`<label>` + `<div>` siblings, not `<label>` wrapping input)
3. **Consistent layout**: Single CSS module for all form field styling

### What NOT to Do

```tsx
// Don't wrap inputs in labels (causes hover cascade)
<label>
  Name
  <Input />
</label>

// Don't use manual label/input without htmlFor/id pairing
<label>Name</label>
<Input />
```

## Input Component

| Prop | When to Use |
|------|-------------|
| (default) | Standalone form field |
| `filled` | Input inline with text |
| `compact` | Dense/tight UI rows |
| `filled compact` | Inline + dense |

## Interactive States

| Token | Value | Purpose |
|-------|-------|---------|
| `--gs-hover-bg` | `#e5e7eb` / brand elevated | Background on hover |
| `--gs-focus-ring` | `rgba(16, 132, 255, 0.65)` | Focus outline color |

### Hover Patterns

| Type | Hover Effect |
|------|--------------|
| Buttons/Controls | `background: var(--gs-hover-bg)` |
| Cards/Surfaces | `background: var(--gs-hover-bg)` |
| Form inputs | `border-color: var(--gs-info)` |
| Links | `text-decoration: underline` |

## Motion

Animation answers "what changed?" — it bridges UI states so users understand spatial and causal relationships. If there's no relationship to communicate, don't animate.

### Duration Tokens

| Token | Value | Use |
|-------|-------|-----|
| `--gs-duration-instant` | 0ms | Disabled states, reduced motion fallback |
| `--gs-duration-fast` | 150ms | Micro-interactions, state changes |
| `--gs-duration-moderate` | 200ms | Drawer, modal, collapsible |
| `--gs-duration-slow` | 300ms | Large element transitions (rare) |

### Easing Tokens

| Token | Value | Use |
|-------|-------|-----|
| `--gs-ease-default` | `ease` | General purpose |
| `--gs-ease-out` | `ease-out` | Elements entering |
| `--gs-ease-in` | `ease-in` | Elements exiting |

### Reduced Motion

Respect `prefers-reduced-motion: reduce`. Remove movement (transform, rotate, scale) but keep opacity fades.

## Notifications: Banner vs CalloutBox

Two distinct components for different notification contexts. **Never mix them.**

| Component | Visual | Use For |
|-----------|--------|---------|
| `Banner` | Full-width strip, `border-bottom`, no rounding | Page-level notifications — errors, staleness warnings, status alerts |
| `CalloutBox` | Rounded (`border-radius`), background fill | Inline contextual messages — inside panels, dialogs, forms, sections |

### Decision Tree

```
Where does the notification appear?
│
├─ Top of page / workspace level? → Banner
├─ Inside a detail panel? → CalloutBox
├─ Inside modal or dialog? → CalloutBox
├─ Inside a form section? → CalloutBox
└─ Full-width error bar? → Banner
```

## Data Display

### Table Column Alignment

| Content Type | Alignment | Example |
|--------------|-----------|---------|
| Text, labels | Left | Names, descriptions, IDs |
| Numbers | Right | Quantities, amounts, percentages |
| Boolean indicators | Center | ✓/✗, Yes/No |
| Status tags | Center | Tags, badges |
| Dates | Left or Right | Consistent within table |

### Monospace Font

Use `--gs-font-mono` for system-generated values, not prose.

| Category | Mono? | Examples |
|----------|-------|---------|
| System identifiers | Yes | Stripe IDs, member IDs |
| Currency/cost values | Yes | $50/month |
| Dates | Yes | Due dates, period end dates |
| Human-readable names | No | Member names, plan names |
| Labels/categories | No | Status labels, membership tiers |
| Natural language | No | Notes, descriptions |

**Never mix mono and non-mono within a sentence.**

## Skeletons

**Single-layout skeleton rule:** Components must render one layout path. Use `<Sk>` to mask nullable values inline. Never duplicate structure in a skeleton branch.

```tsx
<KeyValueList rows={[
  { label: 'Email', value: <Sk w="120px">{member?.email}</Sk> },
  { label: 'Status', value: <Sk w="60px">{member?.status}</Sk> },
]} />
```

## Component Reference

Key octahedron components for the Seventy admin UI:

| Component | Use For |
|-----------|---------|
| `DataTable` | Member list, plans list |
| `SurfaceCard` | Detail sections, stats cards |
| `Modal` | Create/edit member, confirmations |
| `ConfirmDialog` | Destructive action confirmations |
| `Input` | Text fields |
| `Select` | Dropdowns (plan selection, filters) |
| `SearchInput` | Member search |
| `Tag` | Membership status badges |
| `Banner` | Page-level alerts |
| `CalloutBox` | Section-level notices |
| `KeyValueList` | Member detail fields |
| `EmptyState` | No results, empty lists |
| `ControlButton` | Primary actions |
| `ControlIconButton` | Icon-only actions |
| `BreadCrumbs` | Page navigation |
| `Sk` | Inline skeleton loading |
| `TabPanelGroup` | Tabbed content |
| `Menu` | Action menus |
| `Tooltip` | Help text, truncated content |

## Membership Status Tags

Map membership statuses to Tag variants consistently:

```tsx
const STATUS_TAG: Record<string, { variant: TagVariant; label: string }> = {
  active:     { variant: 'success', label: 'Active' },
  past_due:   { variant: 'warning', label: 'Past Due' },
  canceled:   { variant: 'danger',  label: 'Canceled' },
  unpaid:     { variant: 'danger',  label: 'Unpaid' },
  incomplete: { variant: 'neutral', label: 'Incomplete' },
};
```
