CREATE OR REPLACE FUNCTION unit_directed_obligation(
  target_group_id bigint, target_unit_id bigint, target_debtor_id bigint, target_creditor_id bigint,
  exclude_settlement_id bigint DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(d.amount_cents), 0)
  FROM group_unit_directed_for_viewer(target_group_id, target_debtor_id, exclude_settlement_id) d
  WHERE d.unit_id = target_unit_id
    AND d.debtor_id = target_debtor_id
    AND d.creditor_id = target_creditor_id
$$;
