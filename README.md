# SplitWisest

**Live:** https://splitwisest-kappa.vercel.app

A private, friend-group expense tracker inspired by Splitwise. Track shared expenses, see who owes who, simplify debts, record offline settlements, and chat in context. **Not a payment app** — no bank connections, cards, or payment processing; settlements are ledger records of payments that happened offline.

## Features

- Username/password auth (scrypt-hashed, session cookies), optional invite-code onboarding
- Groups (trips, apartments, dinners, bills) with per-group currency
- Expenses show payer, date, and category before advanced split choices
- Equal, exact, percentage, shares, and itemized splits; custom categories, notes, and receipt attachments
- Group balances with separate owes and receives allocations; equal, exact, percentage, and shares on each side
- Multi-currency with automatic conversion (rates snapshotted per expense)
- Group + friend balances with exact minimum-payment plans for up to 18 active balances
- Offline settlement recording (group or direct between friends)
- Recurring expenses (weekly/monthly, lazily materialized)
- Search & filtering by group, friend, date, category, payer, text
- Activity log (grouped by day), CSV export, SVG charts
- Notification inbox, per-category phone preferences, and opt-in Web Push with durable retries
- Group chat + direct friend chat with link rendering and search
- Realtime via lightweight polling sync cursor (serverless-friendly)
- Modern, clean UI with one token system, tabular money, and synchronized light and dark controls
- The saved theme wins. Without a saved choice, the app follows the OS preference.
- Installable PWA with safe-area support, a stable app frame, responsive layouts, and a matching offline screen
- Deploy updates wait while an open form contains unsaved text or choices
- Picks up a new deploy on its own — the client compares its build id against the server's and reloads once

## Stack

Next.js (App Router, TypeScript), Tailwind CSS v4, Lucide icons, Neon PostgreSQL via `@neondatabase/serverless`, Zod validation, Vitest.

## Setup

```bash
pnpm install
# .env.local needs DATABASE_URL (SIGNUP_CODE is optional)
pnpm tsx scripts/migrate.ts  # create tables (idempotent)
pnpm migrate:notifications  # additive notification schema
pnpm dev
```

No hosted Neon account? You can run entirely against a local Postgres via a small
Neon-HTTP proxy — see **docs/DATABASE.md → "Local Postgres"** (the `NEON_LOCAL_PROXY`
escape hatch, inert in production).

### Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string (pooler URL, `sslmode=require`) |
| `SIGNUP_CODE` | Optional bootstrap invite code. Friend and group invite codes also work during signup. |

## Testing

```bash
pnpm vitest run          # unit and regression tests
pnpm exec tsc --noEmit   # typecheck
pnpm verify:ui-tokens    # design-token rules
pnpm lint                # lint
pnpm build               # production build
```

Browser checks cover desktop WebKit and realistic phone sizes. The iPhone gate adds the physical-device steps in `docs/PWA.md`.

## Deployment (Vercel)

```bash
vercel --prod
```

Set `DATABASE_URL` in Vercel project env vars. Add `SIGNUP_CODE` only if you want a bootstrap invite code. Run the migration once against the production database before first use.

## Documentation

- `docs/ARCHITECTURE.md` — auth, balance math, settlements, realtime, chat, deployment
- `docs/DATABASE.md` — schema and migration notes for Neon
- `docs/PWA.md` — iPhone layout contract and Safari release checks
- `docs/USAGE.md` — user-facing workflow guide
- `docs/NOTIFICATIONS.md` — event coverage, device setup, delivery, and rollout
