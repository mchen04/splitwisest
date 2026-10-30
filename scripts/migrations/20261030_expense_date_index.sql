CREATE INDEX IF NOT EXISTS expenses_date_idx
  ON expenses (expense_date DESC, id DESC);

INSERT INTO schema_migrations (name)
VALUES ('20261030_expense_date_index')
ON CONFLICT DO NOTHING;
