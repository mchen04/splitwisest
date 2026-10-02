-- Retain create identity after an entry is edited or deleted.
-- Existing balances keep a NULL key. No financial rows change.
BEGIN;
ALTER TABLE group_obligations ADD COLUMN IF NOT EXISTS client_request_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS group_obligations_create_request_idx
  ON group_obligations (group_id, created_by, client_request_id);
CREATE TABLE IF NOT EXISTS group_obligation_create_requests (
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  client_request_id UUID NOT NULL,
  request_payload TEXT NOT NULL,
  obligation_id BIGINT NOT NULL,
  PRIMARY KEY (group_id, created_by, client_request_id)
);
INSERT INTO schema_migrations (name) VALUES ('20260929_group_balances_create_requests') ON CONFLICT DO NOTHING;
COMMIT;
