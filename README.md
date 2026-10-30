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
- Home shows who owes who per friend and, on phones, one-tap group chips; group headers show who you pay or who pays you
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
- Expense, chat, and comment drafts survive app switching, locking, and reloads; an interrupted expense form reopens with its values
- Picks up a new deploy on its own — the client compares its build id against the server's and reloads once

## Stack

Next.js (App Router, TypeScript), Tailwind CSS v4, Lucide icons, Neon PostgreSQL via `@neondatabase/serverless`, Zod validation, Vitest.

## Setup

```bash
pnpm install
pnpm db:local
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/splitwisest
export NEON_LOCAL_PROXY=http://127.0.0.1:4444/sql
pnpm dev
```

Docker Desktop must be running. `db:local` starts local Postgres and its HTTP proxy, then applies both migrations.
Repeated runs preserve local data. `pnpm db:local:down` removes the containers and local data.
Use the printed environment lines if you select different ports.
You can copy `.env.example` to `.env.local` for Next.js; export the same values for QA scripts.
Development refuses Neon URLs unless you set `ALLOW_REMOTE_DB=1` explicitly.
See [database setup](docs/DATABASE.md) and the [script directory](docs/DEVELOPMENT.md).

### Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Local Postgres URL by default; production uses a Neon connection string. |
| `NEON_LOCAL_PROXY` | Local SQL-over-HTTP endpoint. Leave unset for production Neon. |
| `ALLOW_REMOTE_DB` | Set to `1` for intentional Neon access from development or migration scripts. |
| `SIGNUP_CODE` | Optional bootstrap invite code. Friend and group invite codes also work during signup. |

## Testing

```bash
pnpm vitest run          # unit and regression tests
pnpm exec tsc --noEmit   # typecheck
pnpm verify:ui-tokens    # design-token rules
pnpm lint                # lint
pnpm build               # production build
```

The money checks require the dedicated loopback database `splitwisest_money_qa` and its local app and proxy.
Generate one password before launching the ledger and browser checks from the same shell:

```bash
export SPLITWISEST_MONEY_QA_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
pnpm verify:money-ledger
pnpm verify:money-form
unset SPLITWISEST_MONEY_QA_PASSWORD
```

Separate shells must receive the same value through their private local environment configuration.
Without this variable, each process generates its own password and cannot share the ledger login.

Browser checks cover desktop WebKit and realistic phone sizes. The iPhone gate adds the physical-device steps in `docs/PWA.md`.

## Deployment (Vercel)

```bash
vercel --prod
```

Set the production `DATABASE_URL` in Vercel. Leave `NEON_LOCAL_PROXY` unset there.
Add `SIGNUP_CODE` only if you want a bootstrap invite code.
Production builds and Vercel runtime bypass the development guard.
Follow [production migration instructions](docs/DATABASE.md#production-migrations) before first use.

## Documentation

- `docs/ARCHITECTURE.md` — auth, balance math, settlements, realtime, chat, deployment
- `docs/DATABASE.md` — schema and migration notes for Neon
- `docs/PWA.md` — iPhone layout contract and Safari release checks
- `docs/USAGE.md` — user-facing workflow guide
- `docs/NOTIFICATIONS.md` — event coverage, device setup, delivery, and rollout
