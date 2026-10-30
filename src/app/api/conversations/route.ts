import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readSession } from "@/app/api/_lib/read-session";
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";

// Unified conversation list for the Messages master-detail view: every group
// chat and DM the user can see, with last-message preview, timestamp, and
// unread state, sorted most-recently-active first.
export const GET = privateHandler(async (req?: NextRequest) => {
  const { user, rows: [groupRows, dmRows] } = await readSession((userId) => [
    sql`
    SELECT g.id, g.name,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
      lm.id AS last_id, lm.body AS last_body, lm.created_at AS last_at,
      lu.display_name AS last_sender, lm.sender_id AS last_sender_id,
      (SELECT COALESCE(MAX(m.id), 0) FROM messages m
        WHERE m.channel = 'group' AND m.group_id = g.id AND m.sender_id <> ${userId}) AS last_other_id,
      COALESCE((SELECT rs.last_id FROM read_state rs
        WHERE rs.user_id = ${userId} AND rs.scope = 'msg:group:' || g.id), 0) AS read_id
    FROM groups g
    JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ${userId}
    LEFT JOIN LATERAL (
      SELECT m.id, m.body, m.created_at, m.sender_id FROM messages m
      WHERE m.channel = 'group' AND m.group_id = g.id
      ORDER BY m.id DESC LIMIT 1
    ) lm ON TRUE
    LEFT JOIN users lu ON lu.id = lm.sender_id`,
    sql`
    SELECT u.id, u.display_name, u.username,
      lm.id AS last_id, lm.body AS last_body, lm.created_at AS last_at,
      lu.display_name AS last_sender, lm.sender_id AS last_sender_id,
      (SELECT COALESCE(MAX(m.id), 0) FROM messages m
        WHERE m.channel = 'dm' AND m.sender_id <> ${userId}
          AND m.dm_a = LEAST(u.id, ${userId}) AND m.dm_b = GREATEST(u.id, ${userId})) AS last_other_id,
      COALESCE((SELECT rs.last_id FROM read_state rs
        WHERE rs.user_id = ${userId} AND rs.scope = 'msg:dm:' || u.id), 0) AS read_id
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.user_a = ${userId} THEN f.user_b ELSE f.user_a END
    LEFT JOIN LATERAL (
      SELECT m.id, m.body, m.created_at, m.sender_id FROM messages m
      WHERE m.channel = 'dm' AND m.dm_a = LEAST(u.id, ${userId}) AND m.dm_b = GREATEST(u.id, ${userId})
      ORDER BY m.id DESC LIMIT 1
    ) lm ON TRUE
    LEFT JOIN users lu ON lu.id = lm.sender_id
    WHERE f.user_a = ${userId} OR f.user_b = ${userId}`,
  ]);

  const conversations = [
    ...groupRows.map((g) => ({
      kind: "group" as const,
      id: Number(g.id),
      name: g.name as string,
      subtitle: `${g.member_count} ${Number(g.member_count) === 1 ? "member" : "members"}`,
      lastBody: (g.last_body as string | null) ?? null,
      lastAt: (g.last_at as string | null) ?? null,
      lastSender: g.last_sender_id == null ? null : Number(g.last_sender_id) === user.id ? "You" : (g.last_sender as string),
      lastId: Number(g.last_id ?? 0),
      unread: Number(g.last_other_id) > Number(g.read_id),
    })),
    ...dmRows.map((f) => ({
      kind: "dm" as const,
      id: Number(f.id),
      name: f.display_name as string,
      subtitle: `@${f.username}`,
      lastBody: (f.last_body as string | null) ?? null,
      lastAt: (f.last_at as string | null) ?? null,
      lastSender: f.last_sender_id == null ? null : Number(f.last_sender_id) === user.id ? "You" : (f.last_sender as string),
      lastId: Number(f.last_id ?? 0),
      unread: Number(f.last_other_id) > Number(f.read_id),
    })),
  ].sort((a, b) => b.lastId - a.lastId || a.name.localeCompare(b.name));

  return privateJson(req, { conversations });
});
