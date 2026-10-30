import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readSession } from "@/app/api/_lib/read-session";
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { intParam } from "@/lib/api";
import { activityActionText } from "@/lib/activity";

export const GET = privateHandler(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  // Guard cursor/paging params so a malformed ?since=abc is ignored rather than
  // binding NaN into the id comparison (empty result / opaque 500).
  const since = intParam(q.get("since")) ?? 0;
  const limit = Math.min(Math.max(intParam(q.get("limit")) ?? 50, 1), 200);
  const offset = Math.max(intParam(q.get("offset")) ?? 0, 0);
  const { rows: [rows] } = await readSession((userId) => [sql`
    SELECT a.id, a.group_id, g.name AS group_name, a.actor_id, u.display_name AS actor_name,
      a.type, a.summary, a.data, a.created_at
    FROM activity a
    JOIN users u ON u.id = a.actor_id
    LEFT JOIN groups g ON g.id = a.group_id
    WHERE a.id > ${since} AND (
      a.group_id IN (SELECT group_id FROM group_members WHERE user_id = ${userId})
      OR (a.group_id IS NULL AND a.actor_id = ${userId})
      OR (a.group_id IS NULL AND a.data->'visibleUserIds' ? ${userId}::text)
    )
    ORDER BY a.id DESC LIMIT ${limit + 1} OFFSET ${offset}`]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return privateJson(req, {
    hasMore,
    activity: page.map((a) => ({
      id: Number(a.id),
      groupId: a.group_id ? Number(a.group_id) : null,
      groupName: a.group_name,
      actorId: Number(a.actor_id),
      actorName: a.actor_name,
      actionText: activityActionText({ summary: a.summary, actorName: a.actor_name, data: a.data }),
      type: a.type,
      summary: a.summary,
      createdAt: a.created_at,
    })),
  });
});
