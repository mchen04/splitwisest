CREATE OR REPLACE FUNCTION group_unit_member_unsettled(target_group_id bigint, target_user_id bigint)
RETURNS TABLE(unit_id bigint, unit_name text, reconcile boolean, net_cents bigint, owes_cents bigint, owed_cents bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT v.unit_id, v.unit_name, v.reconcile, v.net_cents, v.owes_cents, v.owed_cents
  FROM group_unit_viewer_rows(target_group_id, target_user_id) v
  WHERE (v.reconcile AND v.net_cents <> 0)
     OR (NOT v.reconcile AND (v.owes_cents <> 0 OR v.owed_cents <> 0))
  ORDER BY v.unit_name, v.unit_id
$$;
