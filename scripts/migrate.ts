import "../src/lib/neon-local";
import { neon } from "@neondatabase/serverless";
import { randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";

function loadLocalEnv() {
  const path = ".env.local";
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] ??= value;
  }
}

loadLocalEnv();

const sql = neon(process.env.DATABASE_URL!);

function isUniqueViolation(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505";
}

// One-time data-fixup migrations are gated through this ledger so the destructive
// UPDATE/DELETE blocks (username dedupe, category dedupe, friend-request dedupe,
// anchor-day backfill) run exactly once instead of re-scanning the full tables —
// and locking out live writes — on every deploy. The CREATE TABLE / ADD COLUMN /
// CREATE INDEX statements remain genuinely idempotent and are left ungated.
async function migrationDone(name: string) {
  const rows = await sql`SELECT 1 FROM schema_migrations WHERE name = ${name}`;
  return rows.length > 0;
}
async function markMigration(name: string) {
  await sql`INSERT INTO schema_migrations (name) VALUES (${name}) ON CONFLICT DO NOTHING`;
}

async function rotateShortInviteCodes(table: "users" | "groups") {
  const rows = table === "users"
    ? await sql`SELECT id FROM users WHERE length(invite_code) < 32 ORDER BY id`
    : await sql`SELECT id FROM groups WHERE length(invite_code) < 32 ORDER BY id`;

  for (const row of rows) {
    const id = Number(row.id);
    let rotated = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const inviteCode = randomBytes(16).toString("hex");
      try {
        const updated = table === "users"
          ? await sql`UPDATE users SET invite_code = ${inviteCode} WHERE id = ${id} AND length(invite_code) < 32 RETURNING 1`
          : await sql`UPDATE groups SET invite_code = ${inviteCode} WHERE id = ${id} AND length(invite_code) < 32 RETURNING 1`;
        rotated = true;
        if (updated.length === 0) break;
        break;
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    if (!rotated) throw new Error(`Could not rotate legacy ${table} invite code for id ${id}`);
  }

  const remaining = table === "users"
    ? await sql`SELECT 1 FROM users WHERE length(invite_code) < 32 LIMIT 1`
    : await sql`SELECT 1 FROM groups WHERE length(invite_code) < 32 LIMIT 1`;
  if (remaining.length > 0) throw new Error(`Legacy short ${table} invite codes remain after migration`);
}

async function main() {
  // Ledger for one-time data-fixup migrations (see migrationDone/markMigration).
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  // ----------------------------------------------------------------------------
  // INDEX / CONCURRENTLY NOTE
  // Every CREATE INDEX below is plain (write-blocking for the build duration) and
  // idempotent (IF NOT EXISTS). At this app's scale the tables are small, so plain
  // builds are fine and safe to re-run. If this migration is ever pointed at an
  // ALREADY-LARGE production table, build the indexes on the big money tables
  // (expenses, settlements, expense_shares, attachments, messages, activity) with
  // `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` run OUT OF BAND instead — plain
  // builds there would stall the 4s-poller write load. CONCURRENTLY cannot run
  // inside a transaction block (this script issues each statement on its own, so
  // it is usable) and can leave an INVALID index on failure, so pair it with a
  // pg_index.indisvalid check rather than relying on IF NOT EXISTS to skip it.
  // ----------------------------------------------------------------------------

  await sql`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // Erasure model: the money/identity tables (expenses.payer_id/created_by,
  // expense_shares.user_id, settlements.payer_id/recipient_id/created_by,
  // groups.created_by, activity.actor_id, messages.sender_id) reference users(id)
  // with the default NO ACTION (RESTRICT-like) — deliberately, since CASCADE there
  // would silently delete settled expenses and corrupt co-members' balances. So a
  // user is never hard-deleted; a future account-deletion endpoint should set
  // deleted_at (after asserting zero balances) and anonymize the profile.
  // getSessionUser() filters deleted_at IS NULL, so stamping it revokes access.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
  if (!(await migrationDone("dedupe_lowercase_usernames"))) {
    await sql`
      UPDATE users u
      SET username = 'sw_migrated_' || u.id || '_' || md5(u.username || ':' || u.id)
      WHERE EXISTS (
        SELECT 1 FROM users keep
        WHERE lower(keep.username) = lower(u.username)
          AND keep.id < u.id
      )`;
    await sql`UPDATE users SET username = lower(username) WHERE username <> lower(username)`;
    await markMigration("dedupe_lowercase_usernames");
  }
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_lower_username_idx ON users (lower(username))`;
  await rotateShortInviteCodes("users");
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_id_advisory_lock_range'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_id_advisory_lock_range CHECK (id BETWEEN 1 AND 2147483647);
      END IF;
    END $$`;

  await sql`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`;

  await sql`CREATE TABLE IF NOT EXISTS auth_rate_limits (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, key)
  )`;

  await sql`CREATE TABLE IF NOT EXISTS friendships (
    user_a BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
  )`;
  // PK (user_a, user_b) only serves user_a; the friends list and the DM-visibility
  // subquery in the 4s sync poller also probe `user_b = X`, which would seq-scan.
  await sql`CREATE INDEX IF NOT EXISTS friendships_user_b_idx ON friendships (user_b)`;

  await sql`CREATE TABLE IF NOT EXISTS groups (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    invite_code TEXT UNIQUE NOT NULL,
    created_by BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await rotateShortInviteCodes("groups");
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'groups_id_advisory_lock_range'
      ) THEN
        ALTER TABLE groups ADD CONSTRAINT groups_id_advisory_lock_range CHECK (id BETWEEN 1 AND 2147483647);
      END IF;
    END $$`;

  await sql`CREATE TABLE IF NOT EXISTS group_members (
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
  )`;
  // Reverse lookup "which groups is this user in" (sync poller, sidebar, activity,
  // relationship checks) cannot use the (group_id, user_id) PK — index user_id.
  await sql`CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members (user_id)`;

  await sql`CREATE TABLE IF NOT EXISTS categories (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'tag',
    owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (owner_id, name)
  )`;

  await sql`CREATE TABLE IF NOT EXISTS expenses (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    currency TEXT NOT NULL,
    converted_cents BIGINT NOT NULL CHECK (converted_cents > 0),
    fx_rate NUMERIC NOT NULL DEFAULT 1,
    expense_date DATE NOT NULL,
    payer_id BIGINT NOT NULL REFERENCES users(id),
    category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
    notes TEXT NOT NULL DEFAULT '',
    split_method TEXT NOT NULL CHECK (split_method IN ('equal','exact','percentage','shares','itemized')),
    itemized_tax_cents BIGINT NOT NULL DEFAULT 0 CHECK (itemized_tax_cents >= 0),
    itemized_tip_cents BIGINT NOT NULL DEFAULT 0 CHECK (itemized_tip_cents >= 0),
    recurring_id BIGINT,
    created_by BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS itemized_tax_cents BIGINT NOT NULL DEFAULT 0 CHECK (itemized_tax_cents >= 0)`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS itemized_tip_cents BIGINT NOT NULL DEFAULT 0 CHECK (itemized_tip_cents >= 0)`;
  // group_balance_rows() filters expenses by group_id in its paid/owed CTEs and is
  // THE hottest read (per group page, per sidebar group, and lateral'd across all of
  // a user's groups on the friends page). Without this index each call seq-scans the
  // whole table. This single index is the highest-leverage fix in the audit.
  await sql`CREATE INDEX IF NOT EXISTS expenses_group_date_idx
    ON expenses (group_id, expense_date DESC, id DESC)`;
  await sql`DROP INDEX IF EXISTS expenses_group_idx`;
  await sql`CREATE INDEX IF NOT EXISTS expenses_title_search_idx
    ON expenses USING gin (title gin_trgm_ops)`;
  await sql`CREATE INDEX IF NOT EXISTS expenses_notes_search_idx
    ON expenses USING gin (notes gin_trgm_ops)`;
  // recurring_id has no FK by default and is joined by the anchor-day backfill below
  // and the recurring materializer. Partial index skips the many non-recurring rows.
  await sql`CREATE INDEX IF NOT EXISTS expenses_recurring_idx ON expenses (recurring_id) WHERE recurring_id IS NOT NULL`;

  await sql`CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id BIGINT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    share_cents BIGINT NOT NULL CHECK (share_cents >= 0),
    raw_input NUMERIC,
    PRIMARY KEY (expense_id, user_id)
  )`;

  await sql`CREATE TABLE IF NOT EXISTS expense_items (
    id BIGSERIAL PRIMARY KEY,
    expense_id BIGINT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
    participant_ids BIGINT[] NOT NULL
  )`;
  await sql`CREATE INDEX IF NOT EXISTS expense_items_expense_idx ON expense_items (expense_id)`;

  await sql`CREATE TABLE IF NOT EXISTS group_obligations (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    owed_method TEXT NOT NULL CHECK (owed_method IN ('equal','exact','percentage','shares')),
    receive_method TEXT NOT NULL CHECK (receive_method IN ('equal','exact','percentage','shares')),
    created_by BIGINT NOT NULL REFERENCES users(id),
    client_request_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS group_obligations_group_idx ON group_obligations (group_id, id DESC)`;
  await sql`ALTER TABLE group_obligations ADD COLUMN IF NOT EXISTS client_request_id UUID`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS group_obligations_create_request_idx
    ON group_obligations (group_id, created_by, client_request_id)`;
  await sql`CREATE TABLE IF NOT EXISTS group_obligation_create_requests (
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    created_by BIGINT NOT NULL REFERENCES users(id),
    client_request_id UUID NOT NULL,
    request_payload TEXT NOT NULL,
    obligation_id BIGINT NOT NULL,
    PRIMARY KEY (group_id, created_by, client_request_id)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS group_obligation_allocations (
    obligation_id BIGINT NOT NULL REFERENCES group_obligations(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK (side IN ('owes','receives')),
    user_id BIGINT NOT NULL REFERENCES users(id),
    share_cents BIGINT NOT NULL CHECK (share_cents >= 0),
    raw_input NUMERIC,
    PRIMARY KEY (obligation_id, side, user_id)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS group_obligation_allocations_user_idx
    ON group_obligation_allocations (user_id)`;

  await sql`CREATE TABLE IF NOT EXISTS attachments (
    id BIGSERIAL PRIMARY KEY,
    expense_id BIGINT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  // The group expense list runs a correlated COUNT(*) on attachments per row, and
  // ON DELETE CASCADE from expenses must find children by expense_id — both seq-scan
  // this (wide, BYTEA) table without an expense_id index.
  await sql`CREATE INDEX IF NOT EXISTS attachments_expense_idx ON attachments (expense_id)`;

  await sql`CREATE TABLE IF NOT EXISTS settlements (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE,
    payer_id BIGINT NOT NULL REFERENCES users(id),
    recipient_id BIGINT NOT NULL REFERENCES users(id),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    currency TEXT NOT NULL,
    converted_cents BIGINT NOT NULL CHECK (converted_cents > 0),
    settled_date DATE NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by BIGINT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (payer_id <> recipient_id)
  )`;
  await sql`ALTER TABLE settlements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
  // group_balance_rows() sums settlements by group_id twice (settled_out/settled_in);
  // friend balances probe the group-less direct settlements by `payer_id = X OR
  // recipient_id = X` (the planner BitmapOrs the two single-column indexes).
  await sql`CREATE INDEX IF NOT EXISTS settlements_group_date_idx
    ON settlements (group_id, settled_date DESC, id DESC)`;
  await sql`DROP INDEX IF EXISTS settlements_group_idx`;
  await sql`CREATE INDEX IF NOT EXISTS settlements_payer_idx ON settlements (payer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS settlements_recipient_idx ON settlements (recipient_id)`;

  await sql`
    CREATE OR REPLACE FUNCTION group_balance_rows(target_group_id bigint)
    RETURNS TABLE(user_id bigint, display_name text, net_cents bigint)
    LANGUAGE sql
    STABLE
    AS $$
      WITH members AS (
        SELECT u.id AS user_id, u.display_name
        FROM group_members gm
        JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = target_group_id
      ),
      paid AS (
        SELECT user_id, SUM(amount_cents)::bigint AS amount_cents FROM (
          SELECT payer_id AS user_id, converted_cents AS amount_cents
          FROM expenses WHERE group_id = target_group_id
          UNION ALL
          SELECT goa.user_id, goa.share_cents AS amount_cents
          FROM group_obligation_allocations goa
          JOIN group_obligations go ON go.id = goa.obligation_id
          WHERE go.group_id = target_group_id AND goa.side = 'receives'
        ) paid_rows GROUP BY user_id
      ),
      -- Per-expense largest-remainder allocation of each expense's converted_cents
      -- across its shares. div()/mod() are exact integer arithmetic (no numeric-
      -- division rounding), so converted owed shares sum EXACTLY to converted_cents
      -- per expense. This eliminates the cross-currency rounding residual that the
      -- old per-share ROUND produced and that the drift CTE below used to dump onto
      -- a single member; the drift correction is now a no-op in the common case.
      owed_alloc AS (
        SELECT
          es.user_id,
          es.expense_id,
          div(es.share_cents::numeric * e.converted_cents, e.amount_cents) AS floor_cents,
          mod(es.share_cents::numeric * e.converted_cents, e.amount_cents) AS remainder,
          e.converted_cents AS exp_converted
        FROM expense_shares es
        JOIN expenses e ON e.id = es.expense_id
        WHERE e.group_id = target_group_id
      ),
      owed_ranked AS (
        SELECT
          oa.user_id,
          oa.floor_cents,
          oa.exp_converted - sum(oa.floor_cents) OVER (PARTITION BY oa.expense_id) AS leftover,
          row_number() OVER (PARTITION BY oa.expense_id ORDER BY oa.remainder DESC, oa.user_id) AS rr
        FROM owed_alloc oa
      ),
      owed AS (
        SELECT user_id, SUM(amount_cents)::bigint AS amount_cents FROM (
          SELECT user_id,
            (floor_cents + CASE WHEN rr <= leftover THEN 1 ELSE 0 END)::bigint AS amount_cents
          FROM owed_ranked
          UNION ALL
          SELECT goa.user_id, goa.share_cents AS amount_cents
          FROM group_obligation_allocations goa
          JOIN group_obligations go ON go.id = goa.obligation_id
          WHERE go.group_id = target_group_id AND goa.side = 'owes'
        ) owed_rows GROUP BY user_id
      ),
      settled_out AS (
        SELECT payer_id AS user_id, COALESCE(SUM(converted_cents), 0) AS amount_cents
        FROM settlements
        WHERE group_id = target_group_id
        GROUP BY payer_id
      ),
      settled_in AS (
        SELECT recipient_id AS user_id, COALESCE(SUM(converted_cents), 0) AS amount_cents
        FROM settlements
        WHERE group_id = target_group_id
        GROUP BY recipient_id
      ),
      raw_balances AS (
        SELECT m.user_id, m.display_name,
          COALESCE(p.amount_cents, 0) - COALESCE(o.amount_cents, 0)
            + COALESCE(so.amount_cents, 0) - COALESCE(si.amount_cents, 0) AS net_cents
        FROM members m
        LEFT JOIN paid p ON p.user_id = m.user_id
        LEFT JOIN owed o ON o.user_id = m.user_id
        LEFT JOIN settled_out so ON so.user_id = m.user_id
        LEFT JOIN settled_in si ON si.user_id = m.user_id
      ),
      drift AS (
        SELECT COALESCE(SUM(net_cents), 0)::bigint AS net_cents
        FROM raw_balances
      ),
      ranked_balances AS (
        SELECT rb.*,
          row_number() OVER (ORDER BY ABS(rb.net_cents) DESC, rb.display_name, rb.user_id) AS drift_rank
        FROM raw_balances rb
      )
      SELECT rb.user_id, rb.display_name,
        (rb.net_cents - CASE WHEN rb.drift_rank = 1 THEN (SELECT net_cents FROM drift) ELSE 0 END)::bigint AS net_cents
      FROM ranked_balances rb
      ORDER BY rb.display_name, rb.user_id
    $$`;

  await sql`CREATE TABLE IF NOT EXISTS recurring_expenses (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    currency TEXT NOT NULL,
    payer_id BIGINT NOT NULL REFERENCES users(id),
    category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
    participant_ids BIGINT[] NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    cadence TEXT NOT NULL CHECK (cadence IN ('weekly','monthly')),
    next_date DATE NOT NULL,
    anchor_day INT,
	    active BOOLEAN NOT NULL DEFAULT true,
	    created_by BIGINT NOT NULL REFERENCES users(id),
	    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
	  )`;

	  await sql`ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS anchor_day INT`;
	  await sql`ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
  await sql`CREATE INDEX IF NOT EXISTS recurring_expenses_group_idx ON recurring_expenses (group_id, id)`;
  await sql`CREATE INDEX IF NOT EXISTS recurring_expenses_due_idx
    ON recurring_expenses (group_id, next_date, id) WHERE active`;
  if (!(await migrationDone("backfill_recurring_anchor_day"))) {
    await sql`
      UPDATE recurring_expenses r
      SET anchor_day = CASE
        WHEN r.cadence = 'monthly' THEN GREATEST(
          EXTRACT(DAY FROM r.next_date)::int,
          COALESCE((
            SELECT MAX(EXTRACT(DAY FROM e.expense_date)::int)
            FROM expenses e
            WHERE e.recurring_id = r.id
          ), 0)
        )
        ELSE EXTRACT(DAY FROM r.next_date)::int
      END
      WHERE r.anchor_day IS NULL`;
    await markMigration("backfill_recurring_anchor_day");
  }

  // expenses.recurring_id was a bare BIGINT with no referential integrity. Null out
  // any dangling references (rules are soft-stopped, not deleted, so there should be
  // none), then add a guarded FK with ON DELETE SET NULL so already-materialized
  // expenses survive if a rule is ever hard-deleted. Guard mirrors the advisory-lock
  // CHECK constraints above so re-running migrate is a no-op.
  await sql`
    UPDATE expenses e SET recurring_id = NULL
    WHERE recurring_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM recurring_expenses r WHERE r.id = e.recurring_id)`;
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'expenses_recurring_fk'
      ) THEN
        ALTER TABLE expenses
          ADD CONSTRAINT expenses_recurring_fk
          FOREIGN KEY (recurring_id) REFERENCES recurring_expenses(id) ON DELETE SET NULL;
      END IF;
    END $$`;

  await sql`CREATE TABLE IF NOT EXISTS activity (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE,
    actor_id BIGINT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS activity_group_idx ON activity (group_id, id)`;
  await sql`CREATE INDEX IF NOT EXISTS activity_direct_actor_idx
    ON activity (actor_id, id) WHERE group_id IS NULL`;
  await sql`CREATE INDEX IF NOT EXISTS activity_visible_users_idx
    ON activity USING gin ((data->'visibleUserIds')) WHERE group_id IS NULL`;

  await sql`CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    channel TEXT NOT NULL CHECK (channel IN ('group','dm')),
    group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE,
    dm_a BIGINT REFERENCES users(id) ON DELETE CASCADE,
    dm_b BIGINT REFERENCES users(id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
      (channel = 'group' AND group_id IS NOT NULL) OR
      (channel = 'dm' AND dm_a IS NOT NULL AND dm_b IS NOT NULL AND dm_a < dm_b)
    )
  )`;
  await sql`CREATE INDEX IF NOT EXISTS messages_group_idx ON messages (group_id, id)`;
  await sql`CREATE INDEX IF NOT EXISTS messages_dm_idx ON messages (dm_a, dm_b, id)`;
  await sql`CREATE INDEX IF NOT EXISTS messages_body_search_idx
    ON messages USING gin (body gin_trgm_ops)`;

  await sql`CREATE TABLE IF NOT EXISTS fx_rates (
    currency TEXT PRIMARY KEY,
    rate_per_usd NUMERIC NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  // One-time account recovery codes. Each code is scrypt-hashed (never stored
  // plaintext) and single-use; spending one stamps used_at.
  await sql`CREATE TABLE IF NOT EXISTS recovery_codes (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes (user_id)`;

  // Per-expense comment threads (Splitwise-style discussion on a single bill).
  await sql`CREATE TABLE IF NOT EXISTS expense_comments (
    id BIGSERIAL PRIMARY KEY,
    expense_id BIGINT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS expense_comments_idx ON expense_comments (expense_id, id)`;

  // Per-user read cursors. `scope` is a string like 'activity',
  // 'msg:group:<id>', or 'msg:dm:<friendId>'; last_id is the highest id the
  // user has seen in that scope. Drives unread badges.
  await sql`CREATE TABLE IF NOT EXISTS read_state (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    last_id BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, scope)
  )`;

  // Settle-up nudges. A reminder from one user to another (optionally scoped to
  // a group) to settle an outstanding balance. Surfaces as the recipient's
  // notification until they dismiss it (seen_at).
  await sql`CREATE TABLE IF NOT EXISTS nudges (
    id BIGSERIAL PRIMARY KEY,
    from_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS nudges_to_idx ON nudges (to_id, id)`;
  await sql`CREATE INDEX IF NOT EXISTS nudges_unseen_to_idx ON nudges (to_id, id) WHERE seen_at IS NULL`;

  // Pending friend requests. Adding a friend by code now creates a request the
  // recipient accepts or declines, instead of an instant two-way friendship.
  await sql`CREATE TABLE IF NOT EXISTS friend_requests (
    id BIGSERIAL PRIMARY KEY,
    from_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (from_id, to_id),
    CHECK (from_id <> to_id)
  )`;
  if (!(await migrationDone("dedupe_friend_requests"))) {
    await sql`
      DELETE FROM friend_requests fr
      USING friend_requests newer
      WHERE LEAST(fr.from_id, fr.to_id) = LEAST(newer.from_id, newer.to_id)
        AND GREATEST(fr.from_id, fr.to_id) = GREATEST(newer.from_id, newer.to_id)
        AND fr.id < newer.id`;
    await markMigration("dedupe_friend_requests");
  }
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_pair_idx
    ON friend_requests (LEAST(from_id, to_id), GREATEST(from_id, to_id))`;
  // The 4s sync poller and the friends list probe `to_id = X` (incoming requests
  // + the MAX(id) cursor); the pair index leads with LEAST/GREATEST and can't
  // serve a bare `to_id` lookup, so this is the one un-indexed hot-path predicate.
  await sql`CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON friend_requests (to_id, id)`;
  await sql`CREATE INDEX IF NOT EXISTS friend_requests_from_idx ON friend_requests (from_id, id)`;

  // Dedupe categories on the same case-insensitive key enforced by routes.
  // Repoint references to the lowest id per owner/name key, delete the rest,
  // then enforce uniqueness with partial expression indexes.
  if (!(await migrationDone("dedupe_categories"))) {
    await sql`
      UPDATE expenses e SET category_id = k.keep_id FROM (
        SELECT owner_id, lower(name) AS key_name, min(id) AS keep_id
        FROM categories
        GROUP BY owner_id, lower(name)
      ) k JOIN categories c ON c.owner_id IS NOT DISTINCT FROM k.owner_id AND lower(c.name) = k.key_name
      WHERE e.category_id = c.id AND e.category_id <> k.keep_id`;
    await sql`
      UPDATE recurring_expenses e SET category_id = k.keep_id FROM (
        SELECT owner_id, lower(name) AS key_name, min(id) AS keep_id
        FROM categories
        GROUP BY owner_id, lower(name)
      ) k JOIN categories c ON c.owner_id IS NOT DISTINCT FROM k.owner_id AND lower(c.name) = k.key_name
      WHERE e.category_id = c.id AND e.category_id <> k.keep_id`;
    await sql`
      DELETE FROM categories c WHERE c.id <> (
        SELECT min(id) FROM categories c2
        WHERE c2.owner_id IS NOT DISTINCT FROM c.owner_id
          AND lower(c2.name) = lower(c.name)
      )`;
    await markMigration("dedupe_categories");
  }
  await sql`DROP INDEX IF EXISTS categories_global_name_idx`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS categories_global_name_idx
    ON categories (lower(name)) WHERE owner_id IS NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS categories_owner_lower_name_idx
    ON categories (owner_id, lower(name)) WHERE owner_id IS NOT NULL`;

  await sql`INSERT INTO categories (name, icon, owner_id) VALUES
    ('General','tag',NULL),
    ('Food & Drink','utensils',NULL),
    ('Groceries','shopping-cart',NULL),
    ('Rent','home',NULL),
    ('Utilities','zap',NULL),
    ('Travel','plane',NULL),
    ('Transport','car',NULL),
    ('Entertainment','clapperboard',NULL),
    ('Shopping','shopping-bag',NULL),
    ('Health','heart-pulse',NULL)
    ON CONFLICT DO NOTHING`;

  // Defense-in-depth: the core money invariant SUM(expense_shares.share_cents) =
  // expenses.amount_cents is otherwise guaranteed only by application code
  // (computeShares). Enforce it at the DB so a logic regression, partial write, or
  // manual data fix can never silently skew every co-member's balance. The trigger
  // is DEFERRABLE INITIALLY DEFERRED so it validates at transaction commit — the
  // expense write paths (insertExpense/updateExpense) wrap the expense row and all
  // of its shares in a single sql.transaction, so the check always sees a complete,
  // consistent expense. On cascade delete of the parent expense it is a no-op.
  await sql`
    CREATE OR REPLACE FUNCTION check_expense_shares_sum()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target_expense bigint;
      expected bigint;
      actual bigint;
    BEGIN
      target_expense := COALESCE(NEW.expense_id, OLD.expense_id);
      SELECT amount_cents INTO expected FROM expenses WHERE id = target_expense;
      IF NOT FOUND THEN
        RETURN NULL; -- parent expense already gone (cascade delete): nothing to check
      END IF;
      SELECT COALESCE(SUM(share_cents), 0) INTO actual
        FROM expense_shares WHERE expense_id = target_expense;
      IF actual <> expected THEN
        RAISE EXCEPTION 'expense_shares for expense % sum to % but amount_cents is %',
          target_expense, actual, expected;
      END IF;
      RETURN NULL;
    END;
    $$`;
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'expense_shares_sum_check') THEN
        CREATE CONSTRAINT TRIGGER expense_shares_sum_check
        AFTER INSERT OR UPDATE OR DELETE ON expense_shares
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_expense_shares_sum();
      END IF;
    END $$`;

  const invalidGroupObligations = await sql`
    SELECT go.id FROM group_obligations go
    LEFT JOIN group_obligation_allocations a ON a.obligation_id = go.id
    GROUP BY go.id
    HAVING COALESCE(SUM(a.share_cents) FILTER (WHERE a.side = 'owes'), 0) <> MAX(go.amount_cents)
        OR COALESCE(SUM(a.share_cents) FILTER (WHERE a.side = 'receives'), 0) <> MAX(go.amount_cents)
    LIMIT 1`;
  if (invalidGroupObligations.length) throw new Error("Existing group balance allocations do not match their totals");
  await sql`
    CREATE OR REPLACE FUNCTION check_group_obligation_allocations()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_id bigint; expected bigint; owed bigint; received bigint;
    BEGIN
      IF TG_TABLE_NAME = 'group_obligations' THEN
        target_id := NEW.id;
      ELSIF TG_OP = 'DELETE' THEN
        target_id := OLD.obligation_id;
      ELSE
        target_id := NEW.obligation_id;
      END IF;
      SELECT amount_cents INTO expected FROM group_obligations WHERE id = target_id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      SELECT COALESCE(SUM(share_cents) FILTER (WHERE side = 'owes'), 0),
        COALESCE(SUM(share_cents) FILTER (WHERE side = 'receives'), 0)
        INTO owed, received
      FROM group_obligation_allocations WHERE obligation_id = target_id;
      IF owed <> expected OR received <> expected THEN
        RAISE EXCEPTION 'group obligation % allocations do not match total', target_id;
      END IF;
      RETURN NULL;
    END;
    $$`;
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'group_obligation_allocations_sum_check') THEN
        CREATE CONSTRAINT TRIGGER group_obligation_allocations_sum_check
        AFTER INSERT OR UPDATE OR DELETE ON group_obligation_allocations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION check_group_obligation_allocations();
      END IF;
    END $$`;
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'group_obligations_sum_check') THEN
        CREATE CONSTRAINT TRIGGER group_obligations_sum_check
        AFTER INSERT OR UPDATE OF amount_cents ON group_obligations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION check_group_obligation_allocations();
      END IF;
    END $$`;
  await sql`
    CREATE OR REPLACE FUNCTION forbid_group_obligation_allocation_reparent()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.obligation_id IS DISTINCT FROM OLD.obligation_id THEN
        RAISE EXCEPTION 'group balance allocation parent cannot change';
      END IF;
      RETURN NEW;
    END;
    $$`;
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'group_obligation_allocations_immutable_parent') THEN
        CREATE TRIGGER group_obligation_allocations_immutable_parent
        BEFORE UPDATE OF obligation_id ON group_obligation_allocations
        FOR EACH ROW EXECUTE FUNCTION forbid_group_obligation_allocation_reparent();
      END IF;
    END $$`;
  await markMigration("20260929_group_balances");
  await markMigration("20260929_group_balances_parent_check");
  await markMigration("20260929_group_balances_immutable_allocations");
  await markMigration("20260929_group_balances_create_requests");

  console.log("migration complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
