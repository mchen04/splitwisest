import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";

// Lightweight polling cursor: returns the max activity and message ids visible
// to this user, plus unread counts derived from per-user read_state markers.
// Clients poll this and refetch the affected views when a cursor advances.
export const GET = handler(async () => {
  const user = await requireUser();
  // One round-trip: cursors are computed once in the `cur` CTE and reused by the
  // unread expressions (the activity-unread compares against cur.act rather than a
  // JS literal, which is what previously forced a second query). `my_groups` shares
  // the membership lookup across every subquery and rides the group_members(user_id)
  // index. Unread messages = conversations whose newest message from someone else
  // is past this user's read marker.
  const rows = await sql`
    WITH my_groups AS (
      SELECT group_id FROM group_members WHERE user_id = ${user.id}
    ),
    chans AS (
      SELECT 'msg:group:' || m.group_id AS scope, MAX(m.id) AS maxid
      FROM messages m
      WHERE m.channel = 'group' AND m.sender_id <> ${user.id}
        AND m.group_id IN (SELECT group_id FROM my_groups)
      GROUP BY m.group_id
      UNION ALL
      SELECT 'msg:dm:' || (CASE WHEN m.dm_a = ${user.id} THEN m.dm_b ELSE m.dm_a END) AS scope, MAX(m.id) AS maxid
      FROM messages m
      WHERE m.channel = 'dm' AND m.sender_id <> ${user.id}
        AND (m.dm_a = ${user.id} OR m.dm_b = ${user.id})
        AND EXISTS (
          SELECT 1 FROM friendships f
          WHERE (f.user_a = m.dm_a AND f.user_b = m.dm_b) OR (f.user_a = m.dm_b AND f.user_b = m.dm_a)
        )
      GROUP BY 1
    ),
    cur AS (
      SELECT
        (SELECT COALESCE(MAX(a.id),0) FROM activity a
          WHERE a.group_id IN (SELECT group_id FROM my_groups)
             OR (a.group_id IS NULL AND a.actor_id = ${user.id})
             OR (a.group_id IS NULL AND a.data->'visibleUserIds' ? ${String(user.id)})) AS act,
        (SELECT COALESCE(MAX(m.id),0) FROM messages m
          WHERE m.group_id IN (SELECT group_id FROM my_groups)
             OR EXISTS (
               SELECT 1 FROM friendships f
               WHERE m.channel = 'dm'
                 AND (m.dm_a = ${user.id} OR m.dm_b = ${user.id})
                 AND ((f.user_a = m.dm_a AND f.user_b = m.dm_b) OR (f.user_a = m.dm_b AND f.user_b = m.dm_a))
             )) AS msg,
        (SELECT COALESCE(MAX(n.id),0) FROM nudges n
          WHERE n.to_id = ${user.id} AND n.seen_at IS NULL) AS nudge,
        (SELECT COALESCE(MAX(fr.id),0) FROM friend_requests fr
          WHERE fr.to_id = ${user.id}) AS req
    )
    SELECT cur.act, cur.msg, cur.nudge, cur.req,
      (SELECT COALESCE(MAX(id), 0) FROM notifications n WHERE user_id = ${user.id} AND notification_visible(n)) AS notification_cursor,
      (SELECT count(*)::int FROM notifications n WHERE user_id = ${user.id} AND read_at IS NULL AND notification_visible(n)) AS unread_notifications,
      (SELECT COUNT(*) FROM chans c
        LEFT JOIN read_state r ON r.user_id = ${user.id} AND r.scope = c.scope
        WHERE c.maxid > COALESCE(r.last_id, 0))::int AS unread_messages,
      (CASE WHEN cur.act >
        COALESCE((SELECT last_id FROM read_state WHERE user_id = ${user.id} AND scope = 'activity'), 0)
        THEN 1 ELSE 0 END) AS unread_activity,
      (SELECT COUNT(*) FROM nudges WHERE to_id = ${user.id} AND seen_at IS NULL)::int AS unread_nudges,
      (SELECT COUNT(*) FROM friend_requests WHERE to_id = ${user.id})::int AS unread_requests
    FROM cur`;
  const r = rows[0];

  return NextResponse.json({
    activityCursor: Number(r.act),
    messageCursor: Number(r.msg),
    nudgeCursor: Number(r.nudge),
    requestCursor: Number(r.req),
    notificationCursor: Number(r.notification_cursor),
    unread: {
      messages: Number(r.unread_messages),
      activity: Number(r.unread_activity),
      nudges: Number(r.unread_nudges),
      requests: Number(r.unread_requests),
      balances: Number(r.unread_nudges) + Number(r.unread_requests),
      notifications: Number(r.unread_notifications),
    },
  });
});
