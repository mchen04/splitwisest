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
    WHERE e.group_id = target_group_id
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
