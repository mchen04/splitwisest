# Development scripts

Start with `pnpm db:local` and export its two environment lines before running QA scripts.
Keep production Neon opt-in. See [database setup](DATABASE.md).

## Script directory

| File under `scripts/` | Kept because |
|---|---|
| `db-local.ts` | `pnpm db:local` starts, migrates, and removes the disposable local database. |
| `local-db.compose.yml` | The local database command uses it to run Postgres and the HTTP proxy. |
| `apply-migration.ts` | `pnpm migrate:apply` applies SQL with row snapshots and rollback checks. |
| `migration-guard.ts` | Migration runners use its SQL planning and row protection. |
| `migrate.ts` | Local setup, CI, and production setup use the base schema migration. |
| `migrate-notifications.ts` | `pnpm migrate:notifications` and CI install and verify notification tables and triggers. |
| `notifications.sql` | The notification migration runner applies this schema. |
| `migrations/20260929_group_balances.sql` | Existing deployments need this ordered group balance migration. |
| `migrations/20260929_group_balances_parent_check.sql` | Existing deployments need this parent allocation check. |
| `migrations/20260929_group_balances_immutable_allocations.sql` | Existing deployments need this allocation ownership guard. |
| `migrations/20260929_group_balances_create_requests.sql` | Existing deployments need this create-request ledger. |
| `migrations/20261015_currency_balance_units.sql` | Existing deployments need this currency-unit migration. |
| `check-ui-tokens.ts` | `pnpm verify:ui-tokens` and its tests enforce shared design tokens. |
| `generate-sw.ts` | `pnpm build` generates the versioned service worker. |
| `qa-support.ts` | Core and profile verifiers share its HTTP, SQL, fixture, and cleanup helpers. |
| `seed-ux-demo.ts` | The PWA swap harness calls it to create its synthetic browser fixtures. |
| `money-qa.ts` | Money verifiers share its isolated-database and app checks. |
| `verify-core-flows.ts` | `pnpm verify:core` checks core app flows through real HTTP and SQL. |
| `verify-private-profiles.ts` | `pnpm verify:profiles` checks profile visibility through real app routes. |
| `verify-notifications.ts` | `pnpm verify:notifications` checks isolated notification and delivery flows. |
| `verify-monthly-reminders.ts` | `pnpm verify:monthly-reminders` and CI check reminder eligibility and delivery. |
| `verify-money-ledger.ts` | `pnpm verify:money-ledger` compares stored money with API and balance results. |
| `verify-money-form.ts` | `pnpm verify:money-form` checks browser previews, saves, and edits. |
| `pwa-swap-harness.mjs` | [PWA verification](PWA.md#two-build-verification) checks updates across two local builds. |
| `perf-measure.mjs` | [Performance verification](PWA.md#performance-measurement) measures local Lighthouse results and payload sizes. |
| `verify-mobile-overflow.mjs` | [Mobile verification](PWA.md#date-and-split-overflow-regression) checks real form boundaries. |
| `verify-monthly-reminder-ui.ts` | [Notification verification](NOTIFICATIONS.md) checks retained fixtures in desktop and mobile browsers. |
| `verify-notification-read-state.mjs` | [Notification verification](NOTIFICATIONS.md) checks accessible read and unread states. |

## Test scope

Keep tests that run application logic and compare its results with independent expectations.
Mocked I/O can isolate real route, cache, worker, and browser decision logic.
Source wording checks cannot prove runtime behavior; use the documented browser checks for layout and wiring.
