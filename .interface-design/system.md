# SplitWisest Interface Design System

Direction: **modern · clean · minimal** — the register of Linear / Stripe / Mercury /
Things. Flat near-neutral surfaces, one sans typeface with tabular figures for money,
a restrained green accent used as *signal* (not decoration), and generous, consistent
space. Personality comes from sharp typography and the green — not from texture or
ornament. Consistency beats novelty; these decisions compound — follow them.

> Pivoted from the earlier "warm paper + serif" direction after a four-judge design
> review: serif-everywhere + dotted grain + warm cream read editorial/cozy, not modern.
> We kept the bones (layout, green brand, logo, icon set, nav) and replaced the three
> foundational choices: **serif → sans, texture → flat, warm cream → cool neutral.**

## Foundation

- All color, type, spacing, elevation are tokens in `src/app/globals.css` (`@theme`).
  **Never hard-code hex in components** — the only exception is the deterministic
  Avatar hue.
- Light: canvas `paper #f5f6f7`, `card #ffffff`, `subtle #eef0f2` (fills/hover),
  `ink #181b1f`, `ink-soft #545b63`, `ink-faint #565d64`, `line #e5e7ea`.
- Dark: `[data-theme="dark"]` flips the same token names. Cards **lift** above the
  canvas (`paper #131619` → `card #1c2024`) — depth is a surface-lightness step, not a
  shadow (shadows are invisible in dark UIs).
- Accent: green `#15795f` (light) / `#3fb488` (dark) — brand, primary buttons, active
  nav, links. `accent-soft` is the active-nav pill / subtle fill.
- **Money semantics are distinct from the brand:** `owed` green `#0e8a63` (you're
  owed / +), `owe` warm `#c2540f` (you owe / −), `danger` red `#d4342a` (destructive
  only). Never let "you owe" and "delete" share a color.
- Depth: 1px `border-line` is the primary separator; cards carry a near-invisible
  `shadow-card`. `shadow-pop` is reserved for modals / floating menus. No other shadows.
- **No texture.** The dotted grain is gone; surfaces are flat.

## Typography

- One typeface: **Instrument Sans** (`--font-body`) for *everything* — body, headings,
  labels, and money. `.font-display` maps to the same sans; hierarchy comes from
  **size + weight + color**, never from a second typeface.
- The serif (**Fraunces**) survives **only** in the wordmark via `.font-wordmark`.
  Do not reintroduce it anywhere else.
- Money & aligned figures use `.tnum` (tabular figures) so columns line up and digits
  don't reflow as values change.
- Ramp: `xs` 12/16, `sm` 14/20, `base` 16/24, `xl` 20/28,
  `2xl` 24/32, `3xl` 32/36, `4xl` 40/44. The 18px `lg` step is disabled.
- **Screens use type roles, not ramp sizes.** Each role names a job:
  `text-meta` 12/16 (timestamps, counts, helper text), `text-body` 14/20 (secondary
  text, labels, buttons), `text-row` (row titles: 16/20 on phones, 14/20 from 768px),
  `text-section` 16/24 (card and section headings), `text-title` 20/28 (a group,
  person, or dialog name), `text-amount` 24/32 (a balance), `text-amount-lg` 32/36
  (the amount field, Home currency tiles), `text-hero` 40/44 (the one Home balance).
  Only `ui.tsx` uses the raw ramp (inputs need 16px on phones so iOS does not zoom).
- Card headers use `CardHeader` (`text-section font-semibold`, optional count). Dialog
  titles use `text-title`. Group-inside-card labels use `SectionLabel` (uppercase meta).
- Row titles use `RowTitle` (`text-row font-medium`); metadata uses `RowMeta`
  (`text-meta text-ink-faint`). Unread rows can use semibold.
- Form labels use `text-body font-medium text-ink-soft` and sentence case.

## Spacing & density

4px base; a calm-but-efficient scale: **4 · 8 · 12 · 16 · 24 · 32 · 48**.
Control metrics are tokens: `--control-h` 40px desktop / 44px mobile,
`--control-h-sm` 32px (compact desktop) / 44px mobile, `--row-h` 48px desktop / 52px
mobile. On any touch-first screen (`pointer: coarse`, e.g. an iPad showing the desktop
layout) both control heights and sidebar rows are 44px.
Common roles: card padding `p-4`/`px-4 py-3`, row padding `px-4 py-2.5`, section gap
`gap-4`/`space-y-4`, grid gaps `gap-4`. 8–12px between related items, 16–24px between
groups. **No "no-scroll" mandate** — let content size to content and pages scroll;
never stretch a card to viewport height around a few rows (that produces the dead-space
voids the review flagged).

## Radius scale

- `rounded-lg` (8px) — controls, icon buttons, nav rows, inline chips.
- `rounded-xl` (12px) — Cards, tab strips.
- `rounded-2xl` (16px) — Modal panels, auth card, chat bubbles.
- `rounded-full` — avatars, badges, pills.
Never introduce other radius values.

## Component patterns (`src/components/ui.tsx` is the source of truth)

- **Button**: `min-h-[var(--control-h)]`, `px-3.5`, `text-body font-semibold`, variants
  primary / secondary / ghost / danger; `size="sm"` uses `--control-h-sm` for row
  actions. **One primary per surface** — destructive uses `danger` and is never
  visually dominant. Secondary actions collapse into an `IconButton` group or a `Menu`
  (overflow `⋯`), never a row of 4–5 equal buttons.
- **IconButton / Menu**: icon-only actions carry an `aria-label` and tooltip.
  Their hit area uses `--control-h` (`size="sm"`: `--control-h-sm`). Never hand-roll
  `p-1.5` icon buttons. Menus support arrows, Home, End, Escape, and focus return.
  A menu item that needs data still loading is disabled, never a silent no-op.
- **Segmented**: one row of exclusive choices (inbox filter, theme).
- **Actions live where the number is.** A balance you owe carries its own Settle up;
  a friend who owes you carries Remind; a row's edit/delete sit on the row. Do not send
  the user to another page to act on something already on screen.
- **Toast** (`toast()`): every add, change, delete, copy, and reminder confirms in a
  toast above the mobile nav (`role="status"`). Errors use the error tone. No
  `window.alert`.
- **Confirm** (`confirmAction()`): destructive confirmations use the in-app dialog,
  never `window.confirm` (which shows the site origin in an installed web app).
- **Input / Select / Textarea**: `--control-h`; `bg-card`; focus = `border-accent` +
  3px `ring-accent-soft`. `Select` renders a custom chevron (no raw native arrow).
- **Card**: `border-line` + `shadow-card`, content-sized (never full-height filler).
  `CardHeader` `min-h-11`, sentence-case header, optional single action link.
- **Modal**: bottom sheet on mobile and centered on `sm+`. The mobile panel includes the bottom safe area.
- Modal focus skips hidden and disabled controls. Escape closes the top dialog only and focus returns to the opener.
- With a mouse or keyboard, a dialog focuses its `data-autofocus` field (the amount, a
  name, the confirm button). On touch screens the panel takes focus instead.
- Long forms keep their actions in a sticky footer.
- **Expense form**: keep Paid by, Date, and Category visible after the core fields.
- Default payer to the current user. Use local today and no category as the other defaults.
- Split methods sit in one chip row (One person, Equal, Exact amounts, Percentages,
  Shares, Itemized bill); notes and receipts stay in a disclosure.
- Outside a group, the form opens in place with the group as its first field.
- **Avatar**: deterministic `hsl(hash 52% 45%)`, initials, sizes sm 24 / md 32 / lg 40.
  The current user is colored like everyone else (never a black/empty circle).
- **Money**: `tnum`; when signed, pair color **and** an explicit `+ / −` and, in
  balances, the word ("you're owed" / "you owe") — never color alone.
- **Empty / loading / error**: `EmptyState`, `.skeleton` shimmer, `ErrorNote`.

## Interaction states

- Hover: `hover:bg-subtle` on rows, `hover:bg-accent-dark` on primary.
- Focus: every interactive element shows a visible ring —
  `focus-visible:ring-[3px] focus-visible:ring-accent-soft` (built into Button/inputs).
- Disabled buttons use neutral surface and text tokens. Busy buttons keep their tone, show a spinner, and disable.

## Layout shell

- Desktop/tablet (`md+`): fixed 224px sidebar (wordmark, single Add-expense CTA, nav
  with unread badges, theme toggle, profile) + `max-w-5xl/6xl` main column. The sidebar
  owns the persistent "Add expense" — pages don't duplicate a second primary of equal
  weight.
- Home is a glance surface: **one** hero net-balance number + a contextual next step,
  then groups / friends / a short activity peek.
- Mobile: locked app frame and bottom navigation with safe-area padding.
- The content region scrolls. Chat keeps its own message-list scroll.
- Primary actions stay thumb-reachable. Modal actions include the bottom safe area.
- Master-detail (Messages): left list pane (`lg:w-80`) + detail in one Card from 1024px;
  wide screens auto-select the most recent conversation; phones and tablets show the
  list, then the full-width thread.
- Switchers, not back-outs: group title is a switcher dropdown.
- A group shows all five sections (Expenses, Balances, Chat, Activity, Insights) as tabs
  on every width. The members rail appears from 1024px; below that, member nets live
  in the Balances tab.
- Group tabs and switchers support arrow keys. Menus also support Home, End, and Escape.
- Dense two-column layouts (members rail, profile, settings, chat split) start at
  `lg` (1024px); at 768px they squeezed rows to unreadable widths.

## Content & copy rules

- **Never show raw invite hashes.** Invites are a "Share invite" action (link + QR +
  short human code). The 32-char token lives in the URL, never in the UI.
- Omit empty filler: no "Uncategorized" segment when there's no category; no repeated
  "USD" when everything is one currency.
- One verb per concept: **"Settle up"** (not Settle/Payments mixed); nav "Chat",
  scoped group tab "Group chat".

## Non-goals

No texture, no serif in the UI, no decorative hero sections, no marketing styling, no
row of competing CTAs, no novel one-off controls. Reuse the patterns above or extend
this file deliberately when a new pattern is genuinely needed.

## Enforcement

Run `pnpm verify:ui-tokens` before each UI commit. Components cannot use arbitrary
pixel classes, numeric text or radius classes, or hard-coded hex colors. Structural
viewport, percentage, `calc()`, and CSS-variable values remain valid. Outside `ui.tsx`,
raw ramp sizes (`text-xs` … `text-4xl`) are rejected in favor of type roles, and every
`grid` must declare a base `grid-cols-*` (an implicit column grows to its content and
pushes the page sideways on phones).
