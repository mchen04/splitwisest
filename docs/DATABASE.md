# Database

## Local setup

Start Docker Desktop, then run:

```bash
pnpm db:local
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/splitwisest
export NEON_LOCAL_PROXY=http://127.0.0.1:4444/sql
pnpm dev
```

The command starts Postgres 16 and the [Neon HTTP proxy](https://github.com/TimoWilhelm/local-neon-http-proxy), then applies both migrations.
Repeated runs preserve data and apply missing migrations.
`pnpm db:local:down` removes this checkout's containers and database volume.
Both ports bind only to loopback. Each checkout has separate containers and storage.
For simultaneous checkouts, set unused `SPLITWISEST_PG_PORT` and `SPLITWISEST_PROXY_PORT` values when starting.
Use the two environment lines printed by that command.

Next.js can read these values from `.env.local`; QA and migration scripts use exported values only.
All local commands, including production builds and servers, reject `*.neon.tech` unless `ALLOW_REMOTE_DB=1`.
Only `VERCEL=1` or an explicit `ALLOW_REMOTE_DB=1` permits remote Neon access; `NODE_ENV=production` does not bypass this guard.

## Production migrations

Export the production `DATABASE_URL` deliberately, then run:

```bash
unset NEON_LOCAL_PROXY
ALLOW_REMOTE_DB=1 pnpm tsx scripts/migrate.ts
ALLOW_REMOTE_DB=1 pnpm migrate:notifications
```

Vercel uses its configured Neon URL. Leave `NEON_LOCAL_PROXY` unset there.

## Migration

`scripts/migrate.ts` is idempotent — tables, columns, indexes, and constraints use
`IF NOT EXISTS` / guarded `DO` blocks, and one-time data fixups (username / category
/ friend-request dedupe, anchor-day backfill) are gated through the
`schema_migrations` ledger so they run exactly once instead of re-scanning and
locking the full tables on every deploy. Indexes are built plain (fine at this
scale); on an already-large table, build the money-table indexes with
`CREATE INDEX CONCURRENTLY` out of band instead.

```bash
pnpm tsx scripts/migrate.ts
```

`scripts/migrate.ts` also installs the group-balance tables, balance function,
and allocation guards. If an existing database needs only the group-balance
change, use the four scoped SQL files below in order instead of running the
full migration script. Confirm the database target first.

Apply each scoped SQL file with the guarded runner. Confirm the database target first.

```bash
pnpm migrate:apply scripts/migrations/<file>.sql
```

Add `ALLOW_REMOTE_DB=1` only when deliberately applying a production migration.

The runner snapshots, then applies, then checks:

1. It finds the existing tables the file writes directly (`INSERT`, `UPDATE`, `DELETE`, `ALTER TABLE`,
   `TRUNCATE`, `DROP TABLE`, `MERGE`, `COPY`), including in `DO` blocks. Function bodies are skipped,
   because they do not run during the migration.
2. It saves the rows of those tables to `.migration-snapshots/` (gitignored, mode 600).
3. It runs the file in one transaction. At the start, it records a hash of each existing row in those
   tables. At the end, it fails if any recorded row changed or is gone. Added rows pass, such as the
   `schema_migrations` ledger entry. On failure, PostgreSQL rolls back the whole transaction.

The check ignores tables the file does not write. Live tables such as `sessions` therefore cannot cause a
false failure. A `DO` block with dynamic `EXECUTE` must name its tables with `--writes <table>`.
Writes made by triggers or by functions the file calls are not detected. Name those tables too.
For an intended data fix, pass `--expect-change <table>`, then compare the result with the snapshot.
`--print-transaction` prints the guarded SQL without connecting. `BEGIN` and `COMMIT` lines in a file
are dropped, because the runner owns the transaction.

Apply `scripts/migrations/20260929_group_balances.sql` before
the app update. It creates two tables, replaces the
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

Then apply `scripts/migrations/20260929_group_balances_create_requests.sql`.
It adds a nullable UUID to existing balances, a scoped unique index, and a
create receipt table. Existing financial rows stay unchanged. A receipt keeps
the original request identity after an edit or delete. The transaction rolls
back on failure. Verify its ledger entry, column, index, and unchanged balances.

**Run the migration before deploying the code** — `getSessionUser` references
`users.deleted_at`, which the migration adds.

## Money verifiers

Use an empty database named exactly `splitwisest_money_qa` and a local Neon-HTTP proxy.
Both verifiers refuse non-loopback app, database, and proxy hosts.
They also check that the app uses the same QA database before creating ledger fixtures.

```bash
createdb -h 127.0.0.1 -p 5433 -U postgres splitwisest_money_qa
export DATABASE_URL="${SPLITWISEST_MONEY_QA_DATABASE_URL:?Set your local QA connection string}"
export NEON_LOCAL_PROXY="http://127.0.0.1:4444/sql"
pnpm tsx scripts/migrate.ts
pnpm dev --hostname 127.0.0.1 --port 3000
```

In another terminal, use the same database and proxy exports.
Generate one password for both verifier processes, as shown in the README testing instructions.

```bash
export SPLITWISEST_BASE_URL="http://127.0.0.1:3000"
export SPLITWISEST_BROWSER_URL="http://127.0.0.1:3000"
pnpm verify:money-ledger
pnpm verify:money-form
```

Any local port works. Set the browser URL to the HTTPS origin when the app uses secure cookies.
The ledger verifier creates deterministic synthetic accounts and checks raw rows against API and SQL balances.
The form verifier needs Chromium and the ledger fixtures. It checks previews, saves, and edits.
Stop the QA app, then drop the database with `dropdb -h 127.0.0.1 -p 5433 -U postgres splitwisest_money_qa`.
Recreate and migrate it before another ledger run. Never use a database that contains real records.

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
| `group_obligations` | one group balance record with a description, total in group currency, methods for each side, and an optional create UUID |
| `group_obligation_allocations` | selected members’ owed and received shares; each side sums to the total |
| `group_obligation_create_requests` | original create payload and record ID, retained after an entry is edited or deleted; removed with its group |
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
- Group balance creates use a UUID scoped to the group and creator. A retry with the same payload returns the first record. A changed payload or deleted record rejects the reused UUID. The receipt table retains that decision after edits and deletes.
- `expenses.recurring_id` has an FK to `recurring_expenses(id)` (`ON DELETE SET NULL`) so already-materialized expenses survive a rule deletion.
- Zero-decimal currencies (JPY/KRW) are stored as whole units (multiples of 100 cents) and split in whole units, so a share is never an unpayable fraction of a yen/won.

## Hot query index audit — 2026-10-30

Apply these scoped files to an existing database before the next app release:

```bash
pnpm migrate:apply scripts/migrations/20261030_expense_share_cover_index.sql
pnpm migrate:apply scripts/migrations/20261030_expense_date_index.sql
pnpm migrate:apply scripts/migrations/20261030_message_participant_index.sql
```

The full migration also creates these indexes and records their ledger entries.
Each scoped file creates one index and records its ledger entry.
The files do not update, delete, or backfill application rows.
The existing guidance on concurrent builds for large production tables still applies.

| Index | Read path | Reason |
|---|---|---|
| `expense_shares_cover_idx (expense_id) INCLUDE (user_id, share_cents)` | Group detail and friend balances | Reads shares without fetching their table rows. |
| `expenses_date_idx (expense_date DESC, id DESC)` | Cross-group expense list | Stops after finding one page in date order. |
| `messages_dm_b_idx (dm_b, dm_a, id) INCLUDE (sender_id) WHERE channel = 'dm'` | Sync unread conversations | Finds messages for either participant through indexes. |

The share index supplements the primary key; it does not replace its uniqueness check.
The date index supplements the group-first index, which still serves group pages and balances.
The message index supplements the first-participant index, which still serves conversation reads.
No exact duplicate indexes remain in the measured catalog.
The existing removal of `expenses_group_idx` and `settlements_group_idx` stays in the full migration.
No other index is removed based only on an unused scan counter.
The three new indexes use about 7.7 MiB on this fixture. Insert and update latency is not measured.

### Measurement method

The disposable local database uses PostgreSQL 16.15, 240 users, 60 groups, 30,000 expenses, and 150,000 expense shares.
It also contains 60,000 messages, 60,000 activity rows, 6,000 settlements, 1,200 group balances, and 7,200 balance allocations.
There are 5,000 attachments, 300 recurring templates, 2,400 nudges, 240 friend requests, and 4,800 notifications.
One group has 4,000 expenses; other groups have about 440 expenses.
The busy viewer belongs to ten groups. The typical viewer belongs to three.
Expense dates cover 300 days. Each expense has five shares with valid integer totals.
The sample uses USD. The queries retain the existing currency allocation arithmetic.

Queries come from `src/lib/groups.ts`, `src/lib/balances.ts`, `src/lib/expenses.ts`, and their API routes.
The harness binds synthetic viewer and group values into the existing query text.
Every query uses `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
The baseline has seven timed runs after a warm-up.
Each hypothesis has seven alternating baseline/candidate pairs, with a warm-up before each timed query.
Trials create or drop indexes inside transactions that roll back; their data stays fixed.
The final comparison removes all three new indexes for its baseline.
It then compares that baseline with all three indexes together.

The noise limit is the largest of 5%, the initial baseline spread, and the paired baseline spread.
A spread is `(maximum time - minimum time) / median time`.
A change passes only when its target improves beyond that limit and no measured query regresses beyond its limit.
Docker shares this machine with other work. Some small queries have large relative noise.
The times below measure local database execution, excluding HTTP and response serialization.

### Round log

| Change | Query | Before ms | After ms | Gain | Noise limit | Decision |
|---|---|---:|---:|---:|---:|---|
| Remove existing group date index | group-expenses-heavy | 0.997 | 5.487 | -450.4% | 125.9% | rejected |
| Cover expense shares | friend-balances | 240.951 | 111.586 | 53.7% | 23.9% | kept |
| Order expenses across groups | expenses-all | 6.266 | 0.274 | 95.6% | 24.5% | kept |
| Index second message participant | sync-heavy | 5.164 | 2.146 | 58.4% | 42.0% | kept |
| Cover expense balance columns | friend-balances | 111.152 | 104.565 | 5.9% | 24.1% | rejected |
| Cover group balance allocations | friend-balances | 116.439 | 106.257 | 8.7% | 23.9% | rejected |

The negative control proves the time gate rejects a slower plan.
Both final balance hypotheses fail the gate, so neither index ships.
All fifteen query result hashes match across every comparison.

### Final paired results

Times are medians in milliseconds. Ranges show the seven observed execution times.
Buffer hits come from the plan nearest each median; all plans have zero shared reads after warming.

| Query | Before ms (range) | After ms (range) | Noise limit | Buffer hits before → after | Gain beyond noise |
|---|---:|---:|---:|---:|---|
| sync-heavy | 5.189 (4.592–6.373) | 2.268 (2.012–3.552) | 41.9% | 1450 → 510 | yes |
| detail-heavy | 60.066 (51.869–93.527) | 50.547 (45.596–56.887) | 69.4% | 9219 → 20343 | no |
| group-expenses-heavy | 1.083 (0.743–1.924) | 0.983 (0.769–1.133) | 109.0% | 666 → 319 | no |
| balance-heavy | 55.291 (50.638–66.259) | 57.590 (49.797–66.154) | 35.9% | 1328 → 1328 | no |
| sync-typical | 4.455 (3.418–4.719) | 1.075 (0.739–1.373) | 78.3% | 1421 → 483 | no |
| detail-typical | 19.440 (17.308–22.253) | 6.778 (6.259–8.164) | 38.0% | 1900 → 2277 | yes |
| group-expenses-typical | 1.118 (0.728–1.602) | 1.046 (0.856–1.193) | 78.2% | 656 → 403 | no |
| balance-typical | 19.534 (17.044–22.358) | 6.417 (6.155–11.001) | 27.2% | 1842 → 2219 | yes |
| expenses-all | 5.331 (4.273–6.162) | 0.277 (0.242–0.312) | 35.4% | 7590 → 376 | yes |
| expenses-filtered | 2.097 (1.938–2.818) | 2.447 (1.988–3.206) | 42.0% | 3037 → 3037 | no |
| expenses-friend | 15.363 (11.551–18.880) | 5.406 (4.598–6.208) | 93.1% | 31501 → 1518 | no |
| friend-balances | 238.373 (211.124–270.482) | 105.833 (98.884–116.776) | 24.9% | 26062 → 40561 | yes |
| activity-all | 0.119 (0.085–0.148) | 0.103 (0.075–0.178) | 52.9% | 38 → 38 | no |
| activity-group | 0.100 (0.072–0.174) | 0.089 (0.068–0.182) | 102.0% | 113 → 113 | no |
| recurring | 0.012 (0.007–0.018) | 0.011 (0.006–0.035) | 100.0% | 2 → 2 | no |

The final measured gains are 94.8% for cross-group expenses, 56.3% for busy-viewer sync, and 55.6% for friend balances.
Typical group detail improves by 65.1%, and typical group balances improve by 67.1%.
The typical balance plan replaces a 150,000-row share scan with five index entries per expense.
The busy group still uses a share scan where PostgreSQL estimates it is cheaper.
Its allocation arithmetic remains the largest single-group cost.
Activity already uses the existing group or primary-key indexes; its changes stay within noise.

### Verification

The local checks compare complete row hashes before and after migration, excluding the migration ledger.
They run the full migration twice on fresh, populated, and origin/main-upgraded databases.
They apply each scoped file twice through the guarded runner on a populated local copy.
The origin/main script runs with its environment-file loader removed; it uses only the explicit local connection.
The new regression tests cover index plans, unchanged expense and balance rows, and agreement between migration paths.
They fail when each new index is removed, then pass after it is restored.

Run the focused tests with explicit local test URLs:

```bash
SCHEMA_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55445/splitwisest \
SCHEMA_TEST_PROXY_URL=http://127.0.0.1:54455/sql \
pnpm vitest run src/lib/__tests__/schema-hot-indexes.test.ts src/lib/__tests__/migration-guard.test.ts
```

The live checks require the seeded local fixture. Without both test URLs, only the migration-plan checks run.
Both test URLs must use loopback hosts.
The SQL migration files map to these two focused test files when the test selector reports them as unknown.
The focused run passes 14 tests. Lint passes with three existing warnings, and the TypeScript check passes.
The full test suite remains the orchestrator’s check; this lane runs only the covering tests.
