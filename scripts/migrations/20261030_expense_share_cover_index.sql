CREATE INDEX IF NOT EXISTS expense_shares_cover_idx
  ON expense_shares (expense_id) INCLUDE (user_id, share_cents);

INSERT INTO schema_migrations (name)
VALUES ('20261030_expense_share_cover_index')
ON CONFLICT DO NOTHING;
