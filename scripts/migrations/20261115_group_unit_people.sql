BEGIN;

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
        FROM group_unit_directed(target_group_id) d),
      'people', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'userId', u.id, 'displayName', u.display_name) ORDER BY u.id), '[]'::jsonb)
        FROM users u
        WHERE u.id IN (
          SELECT t.user_id FROM group_unit_totals(target_group_id) t
          UNION
          SELECT d.debtor_id FROM group_unit_directed(target_group_id) d
          UNION
          SELECT d.creditor_id FROM group_unit_directed(target_group_id) d
        ))
    )
  END
$$;

COMMIT;
