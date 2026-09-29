-- Allocation rows belong to one group balance for their full lifetime.
-- This closes the old-parent gap in the deferred sum trigger without changing data.
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

CREATE OR REPLACE FUNCTION forbid_group_obligation_allocation_reparent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.obligation_id IS DISTINCT FROM OLD.obligation_id THEN
    RAISE EXCEPTION 'group balance allocation parent cannot change';
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'group_obligation_allocations_immutable_parent') THEN
    CREATE TRIGGER group_obligation_allocations_immutable_parent
    BEFORE UPDATE OF obligation_id ON group_obligation_allocations
    FOR EACH ROW EXECUTE FUNCTION forbid_group_obligation_allocation_reparent();
  END IF;
END $$;
INSERT INTO schema_migrations (name) VALUES ('20260929_group_balances_immutable_allocations') ON CONFLICT DO NOTHING;
COMMIT;
