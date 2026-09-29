# Architecture

## Layers

- `src/lib/` — pure logic and data access: `money.ts` (split math, debt
  simplification), `balances.ts` (balance queries), `group-obligation-math.ts`
  and `group-obligations.ts` (group balance allocations and writes),
  `settlements.ts` (settlement validation, visibility, authorization),
  `expenses.ts` (expense write paths + recurring materialization), `auth.ts`
  (passwords, sessions), `attachments.ts` (safe upload/download filenames),
  `fx.ts` (currency rates), `api.ts` (route error handling), `activity.ts`
  (log writes), `db.ts` (Neon client), `client.ts` (browser fetch + polling hooks).
- `src/app/api/` — REST route handlers. Every handler authenticates via session cookie and authorizes via group membership / friendship checks before touching data.
- `src/app/` + `src/components/` — client-rendered UI. Pages fetch JSON from the API; no server components touch the DB directly.

## Auth

- Passwords hashed with Node `scrypt` (16-byte random salt, 64-byte key), stored as `scrypt:<salt>:<hash>`. Verification uses `timingSafeEqual`.
- Sessions: 32-byte random token in an httpOnly, SameSite=Lax cookie, stored server-side in `sessions` with 30-day expiry. Logout deletes the row.
- Signup is open by default. If an invite code is supplied, it must match `SIGNUP_CODE`, another user's personal code, or a group invite code; personal and group codes also connect the new user to the inviter or group.
- Password recovery consumes the one-time recovery code, updates the password hash, and invalidates existing sessions in one CTE-backed database statement; the replacement login session is created only after that atomic reset succeeds.
- Auth endpoints are rate-limited by both IP and account (120 / 8 per 15-min window) via a single-statement upsert into `auth_rate_limits`; the account key is the normalized username (un-spoofable), and the client IP is read from the platform-trusted `x-vercel-forwarded-for` / `x-real-ip` headers (falling back to the right-most `x-forwarded-for` hop) so a forged left-most `x-forwarded-for` can't mint a fresh IP bucket per request.
- Defense-in-depth CSRF: the shared `handler` wrapper rejects any non-GET request whose browser `Origin` header doesn't match the request host. `SameSite=Lax` already withholds the cookie cross-site; header-less server/API clients (no `Origin`) are unaffected.

## Money

- All amounts are integer cents. Splits use floor + largest-remainder distribution so shares always sum exactly to the total (`src/lib/money.ts`, covered by Vitest).
- Each expense stores `amount_cents` in its own currency plus `converted_cents` in the group currency, converted at entry time (`fx_rate` snapshot). Later rate changes never alter recorded balances. `getRatesPerUsd` merges the static fallback under cached/live rates so a code missing from the upstream feed still resolves instead of failing conversion.
- Zero-decimal currencies (JPY/KRW) have no minor unit: amounts are snapped to whole units at entry and in `convert()`, and splits distribute whole units, so a share is never an unpayable fraction of a yen/won. Exact splits reject fractional-cent inputs rather than silently rounding.
- Group net per member = expense payments − expense shares + group balance receives − group balance owes + settlements paid − settlements received, all in group currency, computed by `group_balance_rows(group_id)`. The expense share side allocates each expense's `converted_cents` with a per-expense largest-remainder pass (exact integer `div`/`mod`), so converted shares sum exactly to the expense total and no cross-currency rounding residual is misattributed to one member; a whole-group residual-absorption step remains as a defensive backstop. The invariant `SUM(share_cents) = amount_cents` is enforced at the DB by a deferred constraint trigger.
- A group balance stores one total in the group currency. Equal and exact sides use the expense split math. Group balance percentage and share sides use scaled `BigInt` weights, integer quotients, and exact remainders. They do not use the floating-point reimbursement allocator. Weighted splits require a value for each selected person. New splits break rounding ties by user ID. An edit keeps saved cents when a side's inputs have not changed. The difference of the two allocations changes each person’s net. The preview compares this difference with the loaded group net. A save checks that net snapshot under the group's write lock. A changed or deleted edited record invalidates its preview until reopen and refreshes the list and net. Activity sync forces a fresh first-page group balance read. Deferred triggers check sums, and an immediate trigger forbids reparenting allocations. Reopen reads the parent and allocations in one SQL snapshot. These records have no payer and do not enter expense charts or settlement history.
- The group balance list returns its rows and last group balance activity ID from one database snapshot. Group balance API writes serialize under the group advisory lock, so their activity IDs follow commit order within that group. The page checks this scoped cursor on every sync response, including the first, even when the global activity cursor is unchanged. Appended pages remain visible through unrelated activity and clear after any group balance write. Local create, edit, and delete force fresh list and group-net reads, even when older reads are in flight. A changed balance activity ID also forces a fresh group-net read for remote writes.
- Group balance percentage and share inputs use at most seven fractional digits in both the form and API. Percentage sums use scaled integers and must equal 100 exactly. Saved weighted values reopen in plain decimal notation; a pending save blocks form dismissal.
- Member removal checks every group balance allocation reference, including zero shares. The API explains which entry must change before removal.
- Debt simplification (`simplifyDebts`) finds the exact minimum payment count for up to 18 active balances. It partitions balances into the largest possible number of zero-sum sets. Larger groups use the deterministic largest-debtor/largest-creditor fallback.
- Friend and people-profile balances use the same optimized group plans shown on group pages. Each obligation keeps its group and currency, so offsetting groups stay visible and friend-page payments are recorded in the correct group. Group-less payments remain separate direct obligations.

## Settlements

Settlements are ledger rows only (payer, recipient, amount, date, note) — no money movement. Group settlements convert to group currency; direct friend settlements stay in their own currency. Recording any settlement (group or direct) requires the actor to be the payer or recipient, so a member can't fabricate a payment between two other people. Mutating a direct settlement requires being a payer or recipient; mutating a group settlement requires current group membership plus being the payer, recipient, or creator.

## Activity visibility

Group activity is visible through group membership. User-scoped activity, such as friend acceptance/removal and direct settlements, is logged with explicit `visibleUserIds` so both affected users get feed visibility and sync cursor updates.

## Attachments

Receipt uploads are limited to images/PDFs under 4 MB and validated by magic-byte signature (not just the declared MIME), so a script payload posing as an image is rejected at upload. Stored filenames are canonicalized to remove path separators, quotes, and control characters; downloads emit a safe `Content-Disposition` header with both `filename` and `filename*`, are served inline for in-app preview, and carry `X-Content-Type-Options: nosniff` so the browser can't MIME-sniff one into executable HTML.

## Realtime

`GET /api/sync` returns visible cursors for activity, messages, nudges, and friend requests, plus unread counts for messages, activity, nudges, requests, and the aggregate Balances badge — all in a single query (cursors computed in a CTE and reused by the unread expressions). The client polls every 4s (16s when the tab is hidden) via `useSync`; when any cursor advances, affected views refetch and chat panes fetch messages `since` their last id. Activity and message scopes clear through `read_state`; nudges clear via `seen_at`; friend requests clear when accepted/declined/canceled. No websockets — reliable on serverless, no connection state to break.

## Group expense reads

The visible expense list uses bounded pages. Its route materializes due recurring expenses before it reads the list.

Insights uses a separate `all=1` request. That request returns the complete, unfiltered group history with chart fields only.

This separation keeps list responses small. It also prevents filters or pagination from changing chart totals.

## Chat

`messages` rows are either `group` (group_id) or `dm` (ordered user pair). Both endpoints support `since` incremental fetch and `q` substring search. Links render as anchors; everything else is plain text (React escapes by default). On mobile the Chat route takes the frame's whole region and never scrolls it, so the message list scrolls alone while search, composer, Send, and bottom navigation stay visible.

## Mobile PWA shell

The root viewport uses `viewport-fit=cover`. Mobile safe-area values become CSS variables in `src/app/globals.css`. The bottom navigation adds the iPhone inset plus a small lift.

Mobile modal sheets add the bottom inset to their panels. Hidden and disabled controls stay outside each modal focus loop.

On mobile the app is a locked frame rather than a scrolling document. `.app-frame` covers the visible viewport, `.app-scroll` is the only region that scrolls (`.app-fixed` on Chat, which scrolls its own message list), and navigation is the frame's last row. The bar was `position: fixed; bottom: 0` before. iOS resolves that bottom edge differently depending on whether the document can scroll at all, so the bar sat in one place on routes that overflowed and another on routes that fit in one screen; in normal flow it has no viewport to drift against. The lock is scoped to `html:has(.app-frame)`, because login, signup, and recovery render outside the shell and need the document to scroll. The mobile navigation hides while the composer has focus.

No route renders a page title. A title row that differed per page is what made the header appear to change size between tabs, so each page's actions live in its content and `AppShell` takes a `title` for an `sr-only` heading. See `docs/PWA.md` for the verification contract.

The service worker is generated per deploy: `pnpm build` runs
`scripts/generate-sw.ts`, which writes `public/sw.js` (gitignored) from
`src/sw/sw.template.js` with the deployment id embedded, so every deploy ships a
byte-different worker and the browser's own update algorithm installs it. The
deployment id comes from one place (`src/lib/deployment-id.ts`) and reaches the
worker, the client bundle (`NEXT_PUBLIC_BUILD_ID`), `/api/version`, and the
`x-build-id` response header. Navigations are network-first with a bounded
timeout falling back to cached pages and then `offline.html`; content-hashed
`/_next/static/` files are cache-first and swept only when no open window still
runs their build; RSC payloads are never cached and a cross-build payload is
refused so the router hard-navigates instead of mixing builds. One function
(`decideUpdateAction` in `src/lib/update-policy.ts`) makes every reload
decision: at most one reload per detected version, no first-install reload, no
reload of a page already current, a stop instead of a loop when a reload fails
to land, and a deferral while any form holds changed text or choices. The full
contract and its two-build WebKit verification harness are described in
`docs/PWA.md`; measured evidence lives in `docs/pwa-cache-ledger.md`.

(Historical note: the pre-2026-08 worker handed the same `Response` object to
`event.respondWith` and its own background refresh — a body can be read once,
so the refresh died in a bare `catch` for weeks. An app installed before commit
7201b9f serves its cached page before any new code runs and must be re-added to
the Home Screen.)

## Recurring expenses

`recurring_expenses` holds a template and `next_date`. Group detail and expense reads materialize every due period before returning data.

One call creates at most 24 periods. A long-dormant rule defers later periods instead of skipping them.

Each date advance and expense insert share one SQL statement. A stopped process cannot advance a period without its expense.

Postgres `DATE` values become JavaScript `Date` objects. `toYmd` normalizes them before date math.

New rules calculate tomorrow from the local calendar. They do not use a UTC date slice.

## Theming

`.interface-design/system.md` defines the design system. Tailwind tokens live under `@theme` in `src/app/globals.css`.

Runtime tokens, including safe-area values, live under `:root`. Tailwind cannot remove them.

Light and dark palettes use the same token names. Components do not need dark variants.

`themeInitScript` applies the saved choice before paint. Without a saved choice, it reads the OS preference.

`useTheme()` keeps every mounted theme control synchronized. Storage events also synchronize open browser tabs.

OS changes apply when no saved choice exists. The offline page uses the same saved-or-system rule.

## Performance

Over the Neon HTTP driver every `sql` tagged-template is its own network round-trip, so read paths are shaped to minimize both round-trips and full-table scans:

- The hot money tables carry secondary indexes (see `docs/DATABASE.md`), so `group_balance_rows()` index-scans one group instead of sequentially scanning all expenses/settlements.
- The dashboard group list folds each group's balance into one `LEFT JOIN LATERAL group_balance_rows()` query (no per-group N+1); `/api/sync` is a single query; `/api/friends`, `/api/conversations`, and the person profile run their mutually-independent reads with `Promise.all`.
- List endpoints (expenses, settlements) are capped at 200 rows, and malformed numeric query params are ignored rather than turned into errors.

## Deployment

Vercel serverless. Neon over HTTP (`@neondatabase/serverless`), so write paths prefer single-statement CTEs where atomicity matters and otherwise order writes so a mid-sequence failure leaves either a complete record or a cleanly absent one. Run `scripts/migrate.ts` before deploying new code (it is idempotent and ledger-gated; the code depends on columns/indexes it adds).
