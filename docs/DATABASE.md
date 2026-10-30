# Database

## Local setup

Start Docker Desktop and follow the [local run steps](../README.md#run-locally).
`pnpm db:local` starts Postgres 16 and a Neon HTTP proxy on loopback ports 5433 and 4444.
Each checkout gets separate containers and storage.
For concurrent checkouts, set unused `SPLITWISEST_PG_PORT` and `SPLITWISEST_PROXY_PORT` values before running the command.
Export the connection values it prints.
`pnpm db:local:down` deletes that checkout's local database volume.

Next.js reads local environment files; standalone scripts need exported values.
The shared guard rejects `neon.tech` and its subdomains unless `VERCEL=1` or `ALLOW_REMOTE_DB=1`.
`NODE_ENV=production` does not bypass the guard.

## Compute and wake rules

The production configuration uses Neon Free at 0.25 CU, with suspension after five idle minutes.
The estimated budget is about 15 CU-hours per month for three light users; it is not a billing cap.
Authenticated reads, writes, and scheduled delivery can wake the database.
Queries less than five minutes apart keep it awake.
Hidden tabs and tabs idle for two minutes must not poll sync.
Missing or malformed session cookies and API prefetches must not trigger queries.
Public pages, static assets, and `/api/version` do not query the database.
Well-formed unknown session tokens and real authentication attempts still query it.
See [sync rules](ARCHITECTURE.md#reads-and-sync) and [delivery schedules](NOTIFICATIONS.md#schedules-and-retries).

## Production migrations

Confirm the target before running a migration.
Provide `DATABASE_URL` through the process environment and leave `NEON_LOCAL_PROXY` unset for production.
Add `ALLOW_REMOTE_DB=1` only for intended remote access.

For a new database, apply the base schema and then notifications:

```sh
pnpm exec tsx scripts/migrate.ts
pnpm migrate:notifications
```

The base migration creates the current tables, constraints, indexes, and balance function.
It records one-time data fixes in `schema_migrations`.
Apply it before code that requires `users.deleted_at`.
Use scoped migrations for existing deployments instead of rerunning the broad bootstrap for each feature.

For an existing database without group balances, apply these files in order:

```sh
pnpm migrate:apply scripts/migrations/20260929_group_balances.sql
pnpm migrate:apply scripts/migrations/20260929_group_balances_parent_check.sql
pnpm migrate:apply scripts/migrations/20260929_group_balances_immutable_allocations.sql
pnpm migrate:apply scripts/migrations/20260929_group_balances_create_requests.sql
pnpm migrate:apply scripts/migrations/20261015_currency_balance_units.sql
```

These install group balance tables, allocation guards, create receipts, and whole-unit currency allocation.
Preserve the previous balance function before replacing it.
Do not restore a function that ignores group balances while group balance entries exist.

The three `20261030_*` index migrations are applied in production on 2026-10-30.
Apply them to an existing database that lacks them:

```sh
pnpm migrate:apply scripts/migrations/20261030_expense_share_cover_index.sql
pnpm migrate:apply scripts/migrations/20261030_expense_date_index.sql
pnpm migrate:apply scripts/migrations/20261030_message_participant_index.sql
```

| Index | Purpose |
|---|---|
| `expense_shares_cover_idx` | Reads shares by expense with user and amount included. |
| `expenses_date_idx` | Reads cross-group expenses by date and ID. |
| `messages_dm_b_idx` | Reads direct messages through the second participant. |

The index files add indexes and migration records without changing application rows.
The base migration also creates these indexes.
These files build indexes without `CONCURRENTLY`; plan a separate concurrent build for large live tables.

## Guarded SQL runner

`pnpm migrate:apply <file.sql>` snapshots existing tables that the SQL directly writes.
It saves snapshots under the ignored `.migration-snapshots/` directory with file mode 600.
It then runs the migration and row checks in one transaction.
An existing row that changes or disappears fails the check and rolls back the transaction.
New rows are allowed.

| Option | Use |
|---|---|
| `--writes <table>` | Include tables affected through dynamic SQL, called functions, or triggers. |
| `--expect-change <table>` | Allow intended row changes; compare the result with its snapshot. |
| `--print-transaction` | Print guarded SQL without connecting. |

The runner ignores function definitions when finding writes.
It removes file-level BEGIN and COMMIT because it owns the transaction.
`pnpm migrate:notifications` uses this guard and verifies four tables and seven triggers.
It does not backfill historical notifications.

## Data rules

Amounts use integer cents; business dates use DATE and event times use TIMESTAMPTZ.
The driver returns BIGINT values as strings, bytea as hex, and DATE values as JavaScript dates.
Normalize those types before arithmetic, download responses, or date comparisons.

Expense deletion cascades to shares, items, and attachments.
Group deletion removes its scoped financial and message records.
Money references prevent hard deletion of referenced users; authentication excludes users with `deleted_at` set.
See [money rules](ARCHITECTURE.md#money-rules) before changing balances or deletion behavior.

## Database checks

Use disposable databases and a local HTTP proxy.
Apply the base and notification migrations with the chosen database exported.
Start the app with those same exports when a check uses HTTP.
Core and profile checks use `SPLITWISEST_BASE_URL`, which defaults to `http://localhost:3000`.

| Check | Required database | App |
|---|---|---|
| Money ledger and form | `splitwisest_money_qa`, loopback host | Default `http://127.0.0.1:3000`. |
| Notifications | `splitwisest_notifications_qa`, localhost or 127.0.0.1 | Default `http://localhost:3467`. |
| Monthly reminders | `splitwisest_monthly_qa`, localhost, 127.0.0.1, or db.localtest.me | SQL checks need no app. |

Create the dedicated database with your local Postgres tools.
Set `DATABASE_URL` to that database and `NEON_LOCAL_PROXY` to its proxy.
Money checks verify that the app uses the same database before creating fixtures.
Generate one password for both money checks in the same shell:

```sh
export SPLITWISEST_MONEY_QA_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
pnpm verify:money-ledger
pnpm verify:money-form
unset SPLITWISEST_MONEY_QA_PASSWORD
```

The form check needs Chromium and the ledger fixtures.
`SPLITWISEST_BROWSER_URL` overrides its browser origin, for example when using local HTTPS.
Recreate the disposable money database before repeating the ledger check.
See [notification checks](NOTIFICATIONS.md#verification) for their configuration.

Index database checks need 10,000 expenses, group 21, and user 1 with expenses and direct messages.
Set `SCHEMA_TEST_DATABASE_URL` and `SCHEMA_TEST_PROXY_URL` to loopback URLs, then run:

```sh
pnpm exec vitest run src/lib/__tests__/schema-hot-indexes.test.ts src/lib/__tests__/migration-guard.test.ts
```

Without both URLs, the seeded database checks skip; migration-plan checks still run.
