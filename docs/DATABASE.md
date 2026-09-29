# Database (Neon PostgreSQL)

## Migration

`scripts/migrate.ts` is idempotent — tables, columns, indexes, and constraints use
`IF NOT EXISTS` / guarded `DO` blocks, and one-time data fixups (username / category
/ friend-request dedupe, anchor-day backfill) are gated through the
`schema_migrations` ledger so they run exactly once instead of re-scanning and
locking the full tables on every deploy. Indexes are built plain (fine at this
scale); on an already-large table, build the money-table indexes with
`CREATE INDEX CONCURRENTLY` out of band instead.

```bash
DATABASE_URL=... pnpm tsx scripts/migrate.ts
```

For an existing database, `scripts/migrations/20260929_group_balances.sql` is the
scoped group-balance migration. Confirm the database target first. Apply it in
one transaction before the app update. It creates two tables, replaces the
group-balance function, adds a deferred sum check, and records its version in
`schema_migrations`. On failure, PostgreSQL rolls back the whole transaction.
Keep the prior `group_balance_rows(bigint)` definition for recovery. Restore it
only if no group-balance entries exist; once entries exist, preserve the new
tables and their balance effects until the entries are migrated or resolved.

Apply `scripts/migrations/20260929_group_balances_parent_check.sql` after that
migration on existing databases. It checks existing allocations, then adds a
deferred parent trigger. A parent-only insert or total update now fails if
either side does not match the total. The transaction rolls back on failure.

Then apply `scripts/migrations/20260929_group_balances_immutable_allocations.sql`.
It checks existing allocation totals and prevents an allocation from changing
its parent group balance. The transaction rolls back if the check fails.

**Run the migration before deploying the code** — `getSessionUser` references
`users.deleted_at`, which the migration adds.

## Local Postgres (development / CI without a hosted Neon account)

The app talks to Neon over the SQL-over-HTTP driver, so a plain local Postgres
needs a small proxy that speaks that protocol. `src/lib/neon-local.ts` is an
env-gated escape hatch: when `NEON_LOCAL_PROXY` is set (to a proxy's `/sql`
endpoint), the Neon driver is pointed at it. It is **inert in production** — with
`NEON_LOCAL_PROXY` unset the driver behaves exactly as before, and the fail-closed
`DATABASE_URL` check in `db.ts` is untouched.

```bash
# 1) a disposable Postgres + a Neon-HTTP proxy in front of it (Docker)
docker run -d --name sw-pg --network sw-net \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=splitwisest \
  -p 5433:5432 postgres:16
docker run -d --name sw-neon-proxy --network sw-net \
  -e PG_CONNECTION_STRING=postgres://postgres:postgres@sw-pg:5432/splitwisest \
  -p 4444:4444 ghcr.io/timowilhelm/local-neon-http-proxy:main

# 2) point the driver at the proxy (also works for migrate / verify scripts)
export NEON_LOCAL_PROXY="http://localhost:4444/sql"
export DATABASE_URL="postgres://postgres:postgres@localhost:5433/splitwisest"
pnpm tsx scripts/migrate.ts
pnpm dev   # or: pnpm build && pnpm start
```

Pass these on the command line for the `tsx` scripts (they read `.env.local`
*after* the driver is configured, so the env must already be set).

## Tables

| Table | Purpose |
|---|---|
| `users` | username (unique, lowercase), display name, scrypt hash, personal invite code; `deleted_at` soft-delete tombstone (filtered out of auth) |
| `sessions` | auth tokens with expiry |
| `schema_migrations` | ledger of applied one-time migrations and data fixups (`name` → `applied_at`) |
| `friendships` | unordered user pairs (`user_a < user_b`) |
| `groups` | name, currency, invite code |
| `group_members` | membership |
| `categories` | built-in (`owner_id IS NULL`) + per-user custom |
| `expenses` | amount in original currency + `converted_cents` in group currency with `fx_rate` snapshot, split method, payer, category, date, notes |
| `expense_shares` | per-participant integer-cent shares (always sum to `amount_cents`, DB-enforced by a deferred sum-check trigger), raw input (percent/shares/exact) for editing |
| `expense_items` | itemized-bill line items with participant id arrays |
| `group_obligations` | one group balance record with a description, total in group currency, and a method for each side |
| `group_obligation_allocations` | selected members’ owed and received shares; each side sums to the total |
| `attachments` | receipts stored as `bytea` (≤ 4 MB, images/PDF) |
| `settlements` | offline payment ledger; `group_id NULL` = direct friend settlement |
| `recurring_expenses` | templates with cadence + `next_date`, lazily materialized |
| `activity` | append-only log rows shown in activity feeds |
| `messages` | group chat (`group_id`) or DM (`dm_a < dm_b`) |
| `fx_rates` | cached currency rates (units per USD), refreshed daily from open.er-api.com with static fallback |
| `recovery_codes` | one-time account-recovery codes, scrypt-hashed; `used_at` marks a spent code |
| `expense_comments` | per-expense comment threads |
| `read_state` | per-user read cursors keyed by `scope` (`activity`, `msg:group:<id>`, `msg:dm:<friendId>`); clears activity/message unread badges |
| `nudges` | settle-up reminders from one user to another (optionally group-scoped); max unseen id is a sync cursor and `seen_at` dismisses |
| `friend_requests` | pending friend requests (`from_id` → `to_id`); max incoming id is a sync cursor, and accepting/declining/canceling clears request badges |

## Conventions

- Money is always integer cents (`BIGINT`); never floats.
- Dates are `DATE` for business dates, `TIMESTAMPTZ` for event times.
- Cascading deletes: removing an expense removes its shares/items/attachments; removing a group removes its expenses, group balances and allocations, members, messages, activity. User-referencing money FKs intentionally use the default `NO ACTION` (RESTRICT-like) — never cascade — so a user can't be hard-deleted out from under settled balances; erasure goes through `deleted_at`.
- The Neon HTTP driver returns `BIGINT` as strings, `bytea` as `\x`-hex, and `DATE` columns as JS `Date` objects (parsed at local midnight); API routes normalize with `Number(...)` / hex decode, and server-side date math normalizes `Date`→`YYYY-MM-DD` (`toYmd`) rather than `String(date).slice(...)`, which would yield a locale string.
- Attachment filenames are stored only after header/path sanitization; download responses still sanitize again before emitting `Content-Disposition`.

## Indexes & balance function

- Secondary indexes back the hot read paths: `expenses(group_id)` and `settlements(group_id/payer_id/recipient_id)` feed `group_balance_rows()`; `group_obligations(group_id, id DESC)` pages group balances, while `group_obligation_allocations(user_id)` supports user-reference lookups; `group_members(user_id)` and `friendships(user_b)` serve reverse lookups; `attachments(expense_id)` and partial `expenses(recurring_id)` cover the remaining FK joins.
- `group_balance_rows(group_id)` returns each member's net (expense payments − expense shares + group balance receives − group balance owes + settlements paid − received). The expense share side allocates every expense's `converted_cents` with a **per-expense largest-remainder** pass using exact integer `div`/`mod`, so converted shares sum exactly to the expense total and no cross-currency rounding residual is misattributed to one member. A whole-group residual-absorption step remains as a defensive backstop (now a no-op in the common case).
- Group balances add received shares to the credit side and owed shares to the debit side. They use the group currency and never enter spending charts or recorded payments. Deferred triggers check both allocation changes and parent inserts or total updates against the stored total. An immediate trigger forbids changing an allocation's parent balance.
- `expenses.recurring_id` has an FK to `recurring_expenses(id)` (`ON DELETE SET NULL`) so already-materialized expenses survive a rule deletion.
- Zero-decimal currencies (JPY/KRW) are stored as whole units (multiples of 100 cents) and split in whole units, so a share is never an unpayable fraction of a yen/won.
