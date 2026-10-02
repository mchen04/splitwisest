-- Additive notification migration. No historical activity is backfilled.
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled boolean NOT NULL DEFAULT true,
  categories jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(categories) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token text NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
  endpoint text UNIQUE NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  vapid_key text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_session_idx ON push_subscriptions(session_token);

CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  category text NOT NULL CHECK (category IN ('expenses','settlements','comments','messages','reminders','groups','friends','test')),
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  href text NOT NULL CHECK (href LIKE '/%' AND href NOT LIKE '//%'),
  group_id bigint REFERENCES groups(id) ON DELETE CASCADE,
  peer_id bigint REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE(user_id, event_key)
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id, id DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_group_idx ON notifications(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_peer_idx ON notifications(peer_id) WHERE peer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id bigint NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','skipped','failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token text,
  last_status int,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(notification_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_due_idx
  ON notification_deliveries(next_attempt_at) WHERE state IN ('pending','sending');
CREATE INDEX IF NOT EXISTS notification_deliveries_subscription_idx ON notification_deliveries(subscription_id);

CREATE OR REPLACE FUNCTION notification_visible(n notifications) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT n.created_at > now() - interval '90 days' AND (n.group_id IS NULL OR EXISTS (
    SELECT 1 FROM group_members WHERE group_id = n.group_id AND user_id = n.user_id
  )) AND (n.peer_id IS NULL OR EXISTS (
    SELECT 1 FROM friendships
    WHERE user_a = LEAST(n.user_id, n.peer_id) AND user_b = GREATEST(n.user_id, n.peer_id)
  ));
$$;

CREATE OR REPLACE FUNCTION queue_notification_push() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category <> 'test' THEN
    INSERT INTO notification_deliveries(notification_id, subscription_id)
    SELECT NEW.id, s.id FROM push_subscriptions s
    JOIN sessions sess ON sess.token = s.session_token AND sess.expires_at > now()
    LEFT JOIN notification_preferences p ON p.user_id = NEW.user_id
    WHERE s.user_id = NEW.user_id AND sess.user_id = NEW.user_id
      AND COALESCE(p.push_enabled, true)
      AND COALESCE((p.categories->>NEW.category)::boolean, true)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER notifications_queue_push AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION queue_notification_push();

CREATE OR REPLACE FUNCTION notify_recipients(
  recipients bigint[], actor bigint, event_key text, category text, event_type text,
  title text, body text, href text, group_id bigint DEFAULT NULL, peer_id bigint DEFAULT NULL
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO notifications(user_id, event_key, category, type, title, body, href, group_id, peer_id)
  SELECT DISTINCT u.id, event_key, category, event_type, title, body, href, group_id, peer_id
  FROM users u WHERE u.id = ANY(recipients) AND u.id IS DISTINCT FROM actor AND u.deleted_at IS NULL
  ON CONFLICT(user_id, event_key) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION notify_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kind text; heading text; target text; recipients bigint[]; group_name text;
BEGIN
  kind := CASE split_part(NEW.type, '.', 1)
    WHEN 'expense' THEN 'expenses' WHEN 'recurring' THEN 'expenses'
    WHEN 'settlement' THEN 'settlements' WHEN 'group_balance' THEN 'settlements' WHEN 'group' THEN 'groups'
    WHEN 'friend' THEN 'friends' WHEN 'user' THEN 'friends'
  END;
  heading := CASE NEW.type
    WHEN 'expense.added' THEN 'Expense added' WHEN 'expense.edited' THEN 'Expense changed'
    WHEN 'expense.deleted' THEN 'Expense deleted' WHEN 'expense.recurring' THEN 'Recurring expense added'
    WHEN 'expense.receipt_added' THEN 'Receipt added' WHEN 'expense.receipt_removed' THEN 'Receipt removed'
    WHEN 'recurring.created' THEN 'Recurring expense set up' WHEN 'recurring.updated' THEN 'Recurring expense changed'
    WHEN 'recurring.stopped' THEN 'Recurring expense stopped' WHEN 'recurring.paused' THEN 'Recurring expense paused'
    WHEN 'settlement.recorded' THEN 'Payment recorded' WHEN 'settlement.updated' THEN 'Payment changed'
    WHEN 'group_balance.added' THEN 'Group balance added' WHEN 'group_balance.edited' THEN 'Group balance changed'
    WHEN 'group_balance.deleted' THEN 'Group balance deleted'
    WHEN 'settlement.deleted' THEN 'Payment deleted' WHEN 'group.joined' THEN 'Group member joined'
    WHEN 'group.renamed' THEN 'Group renamed' WHEN 'group.member_removed' THEN 'Group membership changed'
    WHEN 'friend.added' THEN 'Friend request accepted' WHEN 'friend.removed' THEN 'Friend removed'
    WHEN 'user.joined' THEN 'Your friend joined SplitWisest'
  END;
  IF heading IS NULL THEN RETURN NEW; END IF;
  IF NEW.group_id IS NOT NULL THEN
    SELECT array_agg(user_id) INTO recipients FROM group_members WHERE group_id = NEW.group_id;
    SELECT name INTO group_name FROM groups WHERE id = NEW.group_id;
    target := '/groups/' || NEW.group_id || '?tab=activity';
    IF NEW.type LIKE 'expense.%' AND NEW.data->>'expenseId' ~ '^[0-9]+$' THEN
      target := '/groups/' || NEW.group_id || '?expense=' || (NEW.data->>'expenseId');
    ELSIF kind = 'settlements' THEN target := '/groups/' || NEW.group_id || '?tab=balances';
    END IF;
  ELSE
    SELECT array_agg(value::bigint) INTO recipients
      FROM jsonb_array_elements_text(COALESCE(NEW.data->'visibleUserIds', '[]'::jsonb)) WHERE value ~ '^[0-9]+$';
    target := '/balances';
  END IF;
  PERFORM notify_recipients(recipients,
    CASE WHEN NEW.type IN ('expense.recurring','recurring.paused') THEN NULL ELSE NEW.actor_id END,
    'activity:' || NEW.id, kind, NEW.type, heading,
    left(NEW.summary, 600) || CASE WHEN group_name IS NULL THEN '' ELSE ' · ' || group_name END,
    target, NEW.group_id);
  IF NEW.type = 'group.member_removed' AND NEW.data->>'removedUserId' ~ '^[0-9]+$' THEN
    PERFORM notify_recipients(ARRAY[(NEW.data->>'removedUserId')::bigint], NEW.actor_id,
      'removed:' || NEW.id, 'groups', NEW.type, 'You were removed from a group',
      'You are no longer a member of ' || COALESCE(group_name, 'this group') || '.', '/groups');
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER activity_notifications AFTER INSERT ON activity
  FOR EACH ROW EXECUTE FUNCTION notify_activity();

CREATE OR REPLACE FUNCTION notify_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipients bigint[]; target text; actor_name text; group_name text;
BEGIN
  SELECT display_name INTO actor_name FROM users WHERE id = NEW.sender_id;
  IF NEW.channel = 'group' THEN
    SELECT array_agg(user_id) INTO recipients FROM group_members WHERE group_id = NEW.group_id;
    SELECT name INTO group_name FROM groups WHERE id = NEW.group_id;
    target := '/groups/' || NEW.group_id || '?tab=chat';
  ELSE
    recipients := ARRAY[NEW.dm_a, NEW.dm_b];
    target := '/chat/' || NEW.sender_id;
  END IF;
  PERFORM notify_recipients(recipients, NEW.sender_id, 'message:' || NEW.id,
    'messages', 'message.' || NEW.channel, 'New message', actor_name || ' sent a message'
      || CASE WHEN group_name IS NULL THEN '.' ELSE ' in ' || group_name || '.' END,
    target, NEW.group_id, CASE WHEN NEW.channel = 'dm' THEN NEW.sender_id ELSE NULL END);
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER message_notifications AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_message();

CREATE OR REPLACE FUNCTION notify_comment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipients bigint[]; gid bigint; actor_name text;
BEGIN
  SELECT group_id INTO gid FROM expenses WHERE id = NEW.expense_id;
  SELECT array_agg(user_id) INTO recipients FROM group_members WHERE group_id = gid;
  SELECT display_name INTO actor_name FROM users WHERE id = NEW.author_id;
  PERFORM notify_recipients(recipients, NEW.author_id, 'comment:' || NEW.id,
    'comments', 'expense.comment', 'New expense comment', actor_name || ' commented on an expense.',
    '/groups/' || gid || '?expense=' || NEW.expense_id, gid);
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER comment_notifications AFTER INSERT ON expense_comments
  FOR EACH ROW EXECUTE FUNCTION notify_comment();

CREATE OR REPLACE FUNCTION notify_nudge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_name text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.seen_at IS NOT NULL AND OLD.seen_at IS NULL THEN
    UPDATE notifications SET read_at = COALESCE(read_at, now())
      WHERE user_id = NEW.to_id AND event_key LIKE 'nudge:' || NEW.id || ':%';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.created_at = OLD.created_at THEN RETURN NEW; END IF;
  SELECT display_name INTO actor_name FROM users WHERE id = NEW.from_id;
  PERFORM notify_recipients(ARRAY[NEW.to_id], NEW.from_id,
    'nudge:' || NEW.id || ':' || NEW.created_at::text, 'reminders', 'nudge.received',
    'Settle-up reminder', actor_name || ' sent a settle-up reminder.', '/balances', NEW.group_id,
    CASE WHEN NEW.group_id IS NULL THEN NEW.from_id ELSE NULL END);
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER nudge_notifications AFTER INSERT OR UPDATE ON nudges
  FOR EACH ROW EXECUTE FUNCTION notify_nudge();

CREATE OR REPLACE FUNCTION notify_friend_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_name text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE event_key = 'request:' || OLD.id;
    RETURN OLD;
  END IF;
  SELECT display_name INTO actor_name FROM users WHERE id = NEW.from_id;
  PERFORM notify_recipients(ARRAY[NEW.to_id], NEW.from_id, 'request:' || NEW.id,
    'friends', 'friend.requested', 'Friend request', actor_name || ' sent a friend request.', '/balances');
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER friend_request_notifications AFTER INSERT OR DELETE ON friend_requests
  FOR EACH ROW EXECUTE FUNCTION notify_friend_request();

CREATE OR REPLACE FUNCTION notify_group_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipients bigint[];
BEGIN
  SELECT array_agg(user_id) INTO recipients FROM group_members WHERE group_id = OLD.id;
  PERFORM notify_recipients(recipients, OLD.created_by, 'group-deleted:' || OLD.id,
    'groups', 'group.deleted', 'Group deleted', OLD.name || ' was deleted.', '/groups');
  RETURN OLD;
END;
$$;
CREATE OR REPLACE TRIGGER group_deleted_notifications BEFORE DELETE ON groups
  FOR EACH ROW EXECUTE FUNCTION notify_group_deleted();

INSERT INTO schema_migrations(name) VALUES ('notifications_v1') ON CONFLICT DO NOTHING;
