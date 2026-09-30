-- Follow-up to the already-applied group balance migration.
-- This checks parent-only inserts and total updates without changing financial rows.
BEGIN;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM group_obligations go
    LEFT JOIN group_obligation_allocations a ON a.obligation_id = go.id
    GROUP BY go.id
    HAVING COALESCE(SUM(a.share_cents) FILTER (WHERE a.side = 'owes'), 0) <> MAX(go.amount_cents)
        OR COALESCE(SUM(a.share_cents) FILTER (WHERE a.side = 'receives'), 0) <> MAX(go.amount_cents)
  ) THEN
    RAISE EXCEPTION 'existing group balance allocations do not match their totals';
  END IF;
END $$;

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
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'group_obligations_sum_check') THEN
    CREATE CONSTRAINT TRIGGER group_obligations_sum_check
    AFTER INSERT OR UPDATE OF amount_cents ON group_obligations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION check_group_obligation_allocations();
  END IF;
END $$;
INSERT INTO schema_migrations (name) VALUES ('20260929_group_balances_parent_check') ON CONFLICT DO NOTHING;
COMMIT;
