CREATE INDEX IF NOT EXISTS messages_dm_b_idx
  ON messages (dm_b, dm_a, id) INCLUDE (sender_id) WHERE channel = 'dm';

INSERT INTO schema_migrations (name)
VALUES ('20261030_message_participant_index')
ON CONFLICT DO NOTHING;
