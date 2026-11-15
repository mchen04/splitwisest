BEGIN;
CREATE TABLE IF NOT EXISTS group_units (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, group_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS group_units_group_name_idx
  ON group_units (group_id, lower(btrim(name)));

ALTER TABLE groups ADD COLUMN IF NOT EXISTS auto_reconcile_units BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS unit_id BIGINT;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS unit_id BIGINT;
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS unit_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_unit_group_fk') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_unit_group_fk
      FOREIGN KEY (unit_id, group_id) REFERENCES group_units(id, group_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_unit_group_fk') THEN
    ALTER TABLE settlements ADD CONSTRAINT settlements_unit_group_fk
      FOREIGN KEY (unit_id, group_id) REFERENCES group_units(id, group_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_expenses_unit_group_fk') THEN
    ALTER TABLE recurring_expenses ADD CONSTRAINT recurring_expenses_unit_group_fk
      FOREIGN KEY (unit_id, group_id) REFERENCES group_units(id, group_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_unit_needs_group') THEN
    ALTER TABLE settlements ADD CONSTRAINT settlements_unit_needs_group
      CHECK (unit_id IS NULL OR group_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_unit_no_conversion') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_unit_no_conversion
      CHECK (unit_id IS NULL OR (converted_cents = amount_cents AND fx_rate = 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_unit_no_conversion') THEN
    ALTER TABLE settlements ADD CONSTRAINT settlements_unit_no_conversion
      CHECK (unit_id IS NULL OR converted_cents = amount_cents);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS expenses_unit_idx ON expenses (group_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS settlements_unit_idx ON settlements (group_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recurring_expenses_unit_idx ON recurring_expenses (group_id, unit_id) WHERE unit_id IS NOT NULL;

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
      FROM expenses WHERE group_id = target_group_id AND unit_id IS NULL
      UNION ALL
      SELECT goa.user_id, goa.share_cents AS amount_cents
      FROM group_obligation_allocations goa
      JOIN group_obligations go ON go.id = goa.obligation_id
      WHERE go.group_id = target_group_id AND goa.side = 'receives'
    ) paid_rows GROUP BY user_id
  ),
  owed_alloc AS (
    SELECT
      es.user_id,
      es.expense_id,
      div(es.share_cents::numeric * e.converted_cents,
        e.amount_cents::numeric * CASE WHEN g.currency IN ('JPY','KRW') THEN 100 ELSE 1 END) AS floor_units,
      mod(es.share_cents::numeric * e.converted_cents,
        e.amount_cents::numeric * CASE WHEN g.currency IN ('JPY','KRW') THEN 100 ELSE 1 END) AS remainder,
      CASE WHEN g.currency IN ('JPY','KRW') THEN 100 ELSE 1 END AS unit_step,
      e.converted_cents / CASE WHEN g.currency IN ('JPY','KRW') THEN 100 ELSE 1 END AS exp_converted
    FROM expense_shares es
    JOIN expenses e ON e.id = es.expense_id
    JOIN groups g ON g.id = e.group_id
    WHERE e.group_id = target_group_id AND e.unit_id IS NULL
  ),
  owed_ranked AS (
    SELECT
      oa.user_id,
      oa.floor_units, oa.unit_step,
      oa.exp_converted - sum(oa.floor_units) OVER (PARTITION BY oa.expense_id) AS leftover,
      row_number() OVER (PARTITION BY oa.expense_id ORDER BY oa.remainder DESC, oa.user_id) AS rr
    FROM owed_alloc oa
  ),
  owed AS (
    SELECT user_id, SUM(amount_cents)::bigint AS amount_cents FROM (
      SELECT user_id,
        ((floor_units + CASE WHEN rr <= leftover THEN 1 ELSE 0 END) * unit_step)::bigint AS amount_cents
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
    WHERE group_id = target_group_id AND unit_id IS NULL
    GROUP BY payer_id
  ),
  settled_in AS (
    SELECT recipient_id AS user_id, COALESCE(SUM(converted_cents), 0) AS amount_cents
    FROM settlements
    WHERE group_id = target_group_id AND unit_id IS NULL
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

CREATE OR REPLACE FUNCTION group_unit_totals(target_group_id bigint)
RETURNS TABLE(unit_id bigint, unit_name text, user_id bigint, display_name text,
  paid_cents bigint, owed_cents bigint, settled_out_cents bigint, settled_in_cents bigint)
LANGUAGE sql
STABLE
AS $$
  WITH paid AS (
    SELECT e.unit_id, e.payer_id AS user_id, SUM(e.amount_cents)::bigint AS cents
    FROM expenses e
    WHERE e.group_id = target_group_id AND e.unit_id IS NOT NULL
    GROUP BY e.unit_id, e.payer_id
  ),
  owed AS (
    SELECT e.unit_id, es.user_id, SUM(es.share_cents)::bigint AS cents
    FROM expense_shares es
    JOIN expenses e ON e.id = es.expense_id
    WHERE e.group_id = target_group_id AND e.unit_id IS NOT NULL
    GROUP BY e.unit_id, es.user_id
  ),
  settled_out AS (
    SELECT s.unit_id, s.payer_id AS user_id, SUM(s.amount_cents)::bigint AS cents
    FROM settlements s
    WHERE s.group_id = target_group_id AND s.unit_id IS NOT NULL
    GROUP BY s.unit_id, s.payer_id
  ),
  settled_in AS (
    SELECT s.unit_id, s.recipient_id AS user_id, SUM(s.amount_cents)::bigint AS cents
    FROM settlements s
    WHERE s.group_id = target_group_id AND s.unit_id IS NOT NULL
    GROUP BY s.unit_id, s.recipient_id
  )
  SELECT gu.id, gu.name, gm.user_id, u.display_name,
    COALESCE(p.cents, 0)::bigint, COALESCE(o.cents, 0)::bigint,
    COALESCE(so.cents, 0)::bigint, COALESCE(si.cents, 0)::bigint
  FROM group_units gu
  JOIN group_members gm ON gm.group_id = gu.group_id
  JOIN users u ON u.id = gm.user_id
  LEFT JOIN paid p ON p.unit_id = gu.id AND p.user_id = gm.user_id
  LEFT JOIN owed o ON o.unit_id = gu.id AND o.user_id = gm.user_id
  LEFT JOIN settled_out so ON so.unit_id = gu.id AND so.user_id = gm.user_id
  LEFT JOIN settled_in si ON si.unit_id = gu.id AND si.user_id = gm.user_id
  WHERE gu.group_id = target_group_id
$$;

CREATE OR REPLACE FUNCTION group_unit_directed(target_group_id bigint, exclude_settlement_id bigint DEFAULT NULL)
RETURNS TABLE(unit_id bigint, unit_name text, debtor_id bigint, creditor_id bigint, amount_cents bigint)
LANGUAGE plpgsql
STABLE
AS $$
  DECLARE
    obligations jsonb := '{}'::jsonb;
    excess jsonb := '{}'::jsonb;
    rec record;
    k text;
    x bigint;
    take bigint;
  BEGIN
    FOR rec IN
      SELECT e.unit_id, es.user_id AS debtor_id, e.payer_id AS creditor_id, SUM(es.share_cents)::bigint AS cents
      FROM expenses e
      JOIN expense_shares es ON es.expense_id = e.id
      WHERE e.group_id = target_group_id AND e.unit_id IS NOT NULL AND es.user_id <> e.payer_id
      GROUP BY e.unit_id, es.user_id, e.payer_id
    LOOP
      k := rec.unit_id || ':' || rec.debtor_id || ':' || rec.creditor_id;
      obligations := jsonb_set(obligations, ARRAY[k],
        to_jsonb(COALESCE((obligations->>k)::bigint, 0) + rec.cents));
    END LOOP;
    FOR rec IN
      SELECT s.unit_id, s.payer_id, s.recipient_id, s.amount_cents
      FROM settlements s
      WHERE s.group_id = target_group_id AND s.unit_id IS NOT NULL
        AND (exclude_settlement_id IS NULL OR s.id <> exclude_settlement_id)
      ORDER BY s.id
    LOOP
      x := rec.amount_cents;
      k := rec.unit_id || ':' || rec.recipient_id || ':' || rec.payer_id;
      take := LEAST(x, COALESCE((excess->>k)::bigint, 0));
      excess := jsonb_set(excess, ARRAY[k], to_jsonb(COALESCE((excess->>k)::bigint, 0) - take));
      x := x - take;
      k := rec.unit_id || ':' || rec.payer_id || ':' || rec.recipient_id;
      take := LEAST(x, COALESCE((obligations->>k)::bigint, 0));
      obligations := jsonb_set(obligations, ARRAY[k], to_jsonb(COALESCE((obligations->>k)::bigint, 0) - take));
      x := x - take;
      IF x > 0 THEN
        excess := jsonb_set(excess, ARRAY[k], to_jsonb(COALESCE((excess->>k)::bigint, 0) + x));
      END IF;
    END LOOP;
    RETURN QUERY
      SELECT gu.id, gu.name, rows.debtor_id, rows.creditor_id, rows.amount_cents
      FROM (
        SELECT split_part(key, ':', 1)::bigint AS unit_id,
          split_part(key, ':', 2)::bigint AS debtor_id,
          split_part(key, ':', 3)::bigint AS creditor_id,
          val::bigint AS amount_cents
        FROM jsonb_each_text(obligations) e(key, val)
        WHERE val::bigint > 0
        UNION ALL
        SELECT split_part(key, ':', 1)::bigint,
          split_part(key, ':', 3)::bigint,
          split_part(key, ':', 2)::bigint,
          val::bigint
        FROM jsonb_each_text(excess) e(key, val)
        WHERE val::bigint > 0
      ) rows
      JOIN group_units gu ON gu.id = rows.unit_id
      ORDER BY gu.name, rows.debtor_id, rows.creditor_id;
  END;
$$;

DROP FUNCTION IF EXISTS unit_directed_obligation(bigint, bigint, bigint, bigint);
DROP FUNCTION IF EXISTS unit_directed_obligation(bigint, bigint, bigint, bigint, bigint);
CREATE OR REPLACE FUNCTION unit_directed_obligation(
  target_group_id bigint, target_unit_id bigint, target_debtor_id bigint, target_creditor_id bigint,
  exclude_settlement_id bigint DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(MAX(d.amount_cents), 0)
  FROM group_unit_directed(target_group_id, exclude_settlement_id) d
  WHERE d.unit_id = target_unit_id
    AND d.debtor_id = target_debtor_id
    AND d.creditor_id = target_creditor_id
$$;

CREATE OR REPLACE FUNCTION group_unit_viewer_rows(target_group_id bigint, target_user_id bigint)
RETURNS TABLE(unit_id bigint, unit_name text, reconcile boolean, net_cents bigint, owes_cents bigint, owed_cents bigint)
LANGUAGE sql
STABLE
AS $$
  WITH totals AS MATERIALIZED (
    SELECT * FROM group_unit_totals(target_group_id)
  ),
  directed AS MATERIALIZED (
    SELECT * FROM group_unit_directed(target_group_id)
  )
  SELECT gu.id, gu.name, g.auto_reconcile_units,
    COALESCE(t.paid_cents - t.owed_cents + t.settled_out_cents - t.settled_in_cents, 0)::bigint,
    COALESCE(d.owes_cents, 0)::bigint,
    COALESCE(d.owed_cents, 0)::bigint
  FROM group_units gu
  JOIN groups g ON g.id = gu.group_id
  LEFT JOIN totals t ON t.unit_id = gu.id AND t.user_id = target_user_id
  LEFT JOIN LATERAL (
    SELECT
      SUM(GREATEST(pair.forward, 0) + GREATEST(-pair.reverse, 0)) AS owes_cents,
      SUM(GREATEST(pair.reverse, 0) + GREATEST(-pair.forward, 0)) AS owed_cents
    FROM (
      SELECT
        SUM(CASE WHEN d.debtor_id = target_user_id THEN d.amount_cents ELSE 0 END) AS forward,
        SUM(CASE WHEN d.creditor_id = target_user_id THEN d.amount_cents ELSE 0 END) AS reverse
      FROM directed d
      WHERE d.unit_id = gu.id AND (d.debtor_id = target_user_id OR d.creditor_id = target_user_id)
      GROUP BY CASE WHEN d.debtor_id = target_user_id THEN d.creditor_id ELSE d.debtor_id END
    ) pair
  ) d ON true
  WHERE gu.group_id = target_group_id
  ORDER BY gu.name, gu.id
$$;

CREATE OR REPLACE FUNCTION group_unit_data(target_group_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM group_units gu WHERE gu.group_id = target_group_id) THEN
    jsonb_build_object(
      'units', (SELECT jsonb_agg(jsonb_build_object('id', gu.id, 'name', gu.name) ORDER BY gu.name, gu.id)
        FROM group_units gu WHERE gu.group_id = target_group_id),
      'totals', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'unitId', t.unit_id, 'userId', t.user_id,
          'paidCents', t.paid_cents, 'owedCents', t.owed_cents,
          'settledOutCents', t.settled_out_cents, 'settledInCents', t.settled_in_cents)
          ORDER BY t.unit_id, t.user_id), '[]'::jsonb)
        FROM group_unit_totals(target_group_id) t),
      'directed', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'unitId', d.unit_id, 'debtorId', d.debtor_id,
          'creditorId', d.creditor_id, 'amountCents', d.amount_cents)
          ORDER BY d.unit_id, d.debtor_id, d.creditor_id), '[]'::jsonb)
        FROM group_unit_directed(target_group_id) d)
    )
  END
$$;

CREATE OR REPLACE FUNCTION group_unit_viewer_json(target_group_id bigint, target_user_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM group_units gu WHERE gu.group_id = target_group_id)
    THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'unitId', u.unit_id, 'name', u.unit_name, 'reconcile', u.reconcile,
      'netCents', u.net_cents, 'owesCents', u.owes_cents, 'owedCents', u.owed_cents)
      ORDER BY u.unit_name, u.unit_id)
      FROM group_unit_viewer_rows(target_group_id, target_user_id) u), '[]'::jsonb)
    ELSE '[]'::jsonb END
$$;

CREATE OR REPLACE FUNCTION group_unit_member_unsettled(target_group_id bigint, target_user_id bigint)
RETURNS TABLE(unit_id bigint, unit_name text, reconcile boolean, net_cents bigint, owes_cents bigint, owed_cents bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT v.unit_id, v.unit_name, v.reconcile, v.net_cents, v.owes_cents, v.owed_cents
  FROM group_unit_viewer_rows(target_group_id, target_user_id) v
  WHERE v.net_cents <> 0 OR v.owes_cents <> 0 OR v.owed_cents <> 0
  ORDER BY v.unit_name, v.unit_id
$$;
COMMIT;
