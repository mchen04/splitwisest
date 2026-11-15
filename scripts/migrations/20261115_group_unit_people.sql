BEGIN;

CREATE OR REPLACE FUNCTION group_unit_data(target_group_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH totals AS MATERIALIZED (
    SELECT * FROM group_unit_totals(target_group_id)
  ),
  directed AS MATERIALIZED (
    SELECT * FROM group_unit_directed(target_group_id)
  ),
  people AS (
    SELECT u.id, u.display_name
    FROM users u
    WHERE u.id IN (
      SELECT t.user_id FROM totals t
      UNION
      SELECT d.debtor_id FROM directed d
      UNION
      SELECT d.creditor_id FROM directed d
    )
    AND NOT EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = target_group_id AND gm.user_id = u.id
    )
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM group_units gu WHERE gu.group_id = target_group_id) THEN
    jsonb_build_object(
      'units', (SELECT jsonb_agg(jsonb_build_object('id', gu.id, 'name', gu.name) ORDER BY gu.name, gu.id)
        FROM group_units gu WHERE gu.group_id = target_group_id),
      'totals', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'unitId', t.unit_id, 'userId', t.user_id,
          'paidCents', t.paid_cents, 'owedCents', t.owed_cents,
          'settledOutCents', t.settled_out_cents, 'settledInCents', t.settled_in_cents)
          ORDER BY t.unit_id, t.user_id), '[]'::jsonb)
        FROM totals t),
      'directed', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'unitId', d.unit_id, 'debtorId', d.debtor_id,
          'creditorId', d.creditor_id, 'amountCents', d.amount_cents)
          ORDER BY d.unit_id, d.debtor_id, d.creditor_id), '[]'::jsonb)
        FROM directed d),
      'people', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'userId', p.id, 'displayName', p.display_name) ORDER BY p.id), '[]'::jsonb)
        FROM people p)
    )
  END
$$;

COMMIT;
