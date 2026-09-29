-- Scoped, one-time schema migration for general group balances.
-- Apply only to the verified Splitwisest neondb database before this code is deployed.
-- The transaction rolls back all changes if any statement fails.
BEGIN;
CREATE TABLE IF NOT EXISTS group_obligations (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  owed_method TEXT NOT NULL CHECK (owed_method IN ('equal','exact','percentage','shares')),
  receive_method TEXT NOT NULL CHECK (receive_method IN ('equal','exact','percentage','shares')),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_obligations_group_idx ON group_obligations (group_id, id DESC);
CREATE TABLE IF NOT EXISTS group_obligation_allocations (
  obligation_id BIGINT NOT NULL REFERENCES group_obligations(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('owes','receives')),
  user_id BIGINT NOT NULL REFERENCES users(id),
  share_cents BIGINT NOT NULL CHECK (share_cents >= 0),
  raw_input NUMERIC,
  PRIMARY KEY (obligation_id, side, user_id)
);
CREATE INDEX IF NOT EXISTS group_obligation_allocations_user_idx
  ON group_obligation_allocations (user_id);

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
    $$;

CREATE OR REPLACE FUNCTION check_group_obligation_allocations()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_id bigint; expected bigint; owed bigint; received bigint;
    BEGIN
      target_id := COALESCE(NEW.obligation_id, OLD.obligation_id);
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
    $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'group_obligation_allocations_sum_check') THEN
    CREATE CONSTRAINT TRIGGER group_obligation_allocations_sum_check
    AFTER INSERT OR UPDATE OR DELETE ON group_obligation_allocations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION check_group_obligation_allocations();
  END IF;
END $$;
INSERT INTO schema_migrations (name) VALUES ('20260929_group_balances') ON CONFLICT DO NOTHING;
COMMIT;
