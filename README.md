# SplitWisest

[Live app](https://splitwisest-kappa.vercel.app)

SplitWisest tracks shared expenses, group balances, and payments made outside the app.
It never moves money or connects to banks.
Groups support multiple currencies, five expense split methods, recurring expenses, chat, and receipt attachments.
The app also provides friend balances, an activity feed, CSV export, an inbox, and optional Web Push.

The stack uses Next.js App Router, React, TypeScript, Tailwind CSS, Neon PostgreSQL, and Vitest.

## Run locally

Use Node.js 24, pnpm 10, and Docker Desktop, as the CI setup does.
Start Docker Desktop, then run:

```sh
pnpm install --frozen-lockfile
pnpm db:local
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/splitwisest
export NEON_LOCAL_PROXY=http://127.0.0.1:4444/sql
pnpm dev
```

Use the environment lines printed by `db:local` if you change its ports.
The command starts Postgres and its HTTP proxy, then applies the base and notification migrations.
Repeated runs preserve data.
`pnpm db:local:down` removes this checkout's containers and database volume.
See [database setup](docs/DATABASE.md) for port overrides and migration rules.

Next.js can read local values from `.env.local`, using [.env.example](.env.example) as a template.
Export the values separately for scripts.
Local commands reject Neon hosts unless `VERCEL=1` or `ALLOW_REMOTE_DB=1`.
Use the local database for development and tests.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. |
| `NEON_LOCAL_PROXY` | Local SQL-over-HTTP endpoint; leave unset on Vercel. |
| `ALLOW_REMOTE_DB` | Set to `1` only for intended remote Neon access. |
| `SIGNUP_CODE` | Optional accepted invite code; setting it does not close signup. |

Personal invite codes connect new users to their inviter.
Group invite codes join new users to a group.
See [notification setup](docs/NOTIFICATIONS.md#setup) for push variables and scheduler secrets.

## Test

Choose checks for the changed feature.
CI runs the full Vitest suite, type check, lint, token check, monthly database checks, and build.

```sh
pnpm exec vitest run src/lib/__tests__/money.test.ts
pnpm exec tsc --noEmit
pnpm lint
pnpm verify:ui-tokens
pnpm build
```

| Command | Coverage |
|---|---|
| `pnpm verify:core` | Core flows through HTTP and SQL. |
| `pnpm verify:profiles` | Profile access through app routes. |
| `pnpm verify:money-ledger` | Stored money, API results, and SQL balances. |
| `pnpm verify:money-form` | Browser previews, saves, and edits. |
| `pnpm verify:notifications` | Notification events, access, and delivery. |
| `pnpm verify:monthly-reminders` | Monthly eligibility, concurrency, and delivery. |

HTTP checks need a running app and the same database exports.
`SPLITWISEST_BASE_URL` selects the app origin.
Use disposable local data: these checks create and delete fixtures.
Money and notification checks need dedicated databases; see [database checks](docs/DATABASE.md#database-checks).
See [PWA checks](docs/PWA.md) for mobile layouts, drafts, and updates across builds.

## Deploy

Set `DATABASE_URL` in Vercel and leave `NEON_LOCAL_PROXY` unset.
Apply the required [migrations](docs/DATABASE.md#production-migrations) before deploying dependent code.
Vercel handles Brotli compression.
Configure push and its two schedulers with the [notification guide](docs/NOTIFICATIONS.md).

## Design references

- [Architecture](docs/ARCHITECTURE.md): money rules, access, sync, and recurring expenses.
- [Interface rules](.interface-design/system.md): tokens, controls, and layout.
