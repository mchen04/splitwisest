import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readGroup } from "@/app/api/_lib/read-group";
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { intParam } from "@/lib/api";
import { activityActionText } from "@/lib/activity";

type Ctx = { params: Promise<{ id: string }> };

export const GET = privateHandler(async (req: NextRequest, { params }: Ctx) => {
  const since = Math.max(intParam(req.nextUrl.searchParams.get("since")) ?? 0, 0);
  const { rows: [rows] } = await readGroup((await params).id, (groupId) => [sql`
    SELECT a.id, a.type, a.summary, a.data, a.created_at, a.actor_id, u.display_name
    FROM activity a JOIN users u ON u.id = a.actor_id
    WHERE a.group_id = ${groupId} AND a.id > ${since}
    ORDER BY a.id DESC LIMIT 100`]);
  return privateJson(req, {
    activity: rows.map((a) => ({
      id: Number(a.id),
      type: a.type,
      summary: a.summary,
      actorId: Number(a.actor_id),
      actorName: a.display_name,
      actionText: activityActionText({ summary: a.summary, actorName: a.display_name, data: a.data }),
      createdAt: a.created_at,
    })),
  });
});
