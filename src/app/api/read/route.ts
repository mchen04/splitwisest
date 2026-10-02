import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { badRequest, forbidden, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";

// Mark a scope read up to `lastId`. Scopes: 'activity', 'msg:group:<id>',
// 'msg:dm:<friendId>'. The marker only ever moves forward.
const Body = z.object({
  scope: z.string().trim().regex(/^(activity|msg:(group|dm):\d+)$/, "Invalid scope"),
  lastId: z.number().int().nonnegative(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const { scope, lastId } = Body.parse(await req.json());
  const cursor = await visibleReadCursor(user.id, scope, lastId);
  await sql.transaction((tx) => [tx`
    INSERT INTO read_state (user_id, scope, last_id, updated_at)
    VALUES (${user.id}, ${scope}, ${cursor.lastId}, now())
    ON CONFLICT (user_id, scope) DO UPDATE
      SET last_id = LEAST(GREATEST(read_state.last_id, ${cursor.lastId}), ${cursor.maxId}), updated_at = now()`,
    tx`UPDATE notifications SET read_at = COALESCE(read_at, now())
      WHERE user_id = ${user.id} AND category = 'messages'
        AND ((${scope} LIKE 'msg:group:%' AND group_id = ${scope.startsWith('msg:group:') ? Number(scope.split(':')[2]) : null})
          OR (${scope} LIKE 'msg:dm:%' AND peer_id = ${scope.startsWith('msg:dm:') ? Number(scope.split(':')[2]) : null}))
        AND split_part(event_key, ':', 2)::bigint <= ${cursor.lastId}`,
  ]);
  return NextResponse.json({ ok: true });
});

async function visibleReadCursor(
  userId: number,
  scope: string,
  requestedLastId: number
): Promise<{ lastId: number; maxId: number }> {
  if (scope === "activity") {
    const rows = await sql`
      SELECT COALESCE(MAX(a.id), 0) AS max_id
      FROM activity a
      WHERE a.group_id IN (SELECT group_id FROM group_members WHERE user_id = ${userId})
         OR (a.group_id IS NULL AND a.actor_id = ${userId})
         OR (a.group_id IS NULL AND a.data->'visibleUserIds' ? ${String(userId)})`;
    const maxId = Number(rows[0].max_id);
    return { lastId: Math.min(requestedLastId, maxId), maxId };
  }

  const match = /^msg:(group|dm):(\d+)$/.exec(scope);
  if (!match) badRequest("Invalid scope");
  const [, kind, rawTargetId] = match;
  const targetId = Number(rawTargetId);

  if (kind === "group") {
    const rows = await sql`
      SELECT
        EXISTS(SELECT 1 FROM group_members WHERE group_id = ${targetId} AND user_id = ${userId}) AS allowed,
        COALESCE((
          SELECT MAX(m.id) FROM messages m
          WHERE m.channel = 'group' AND m.group_id = ${targetId}
        ), 0) AS max_id`;
    if (!rows[0].allowed) forbidden("Not allowed");
    const maxId = Number(rows[0].max_id);
    return { lastId: Math.min(requestedLastId, maxId), maxId };
  }

  const userA = Math.min(userId, targetId);
  const userB = Math.max(userId, targetId);
  const rows = await sql`
    SELECT
      EXISTS(SELECT 1 FROM friendships WHERE user_a = ${userA} AND user_b = ${userB}) AS allowed,
      COALESCE((
        SELECT MAX(m.id) FROM messages m
        WHERE m.channel = 'dm' AND m.dm_a = ${userA} AND m.dm_b = ${userB}
      ), 0) AS max_id`;
  if (!rows[0].allowed) forbidden("Not allowed");
  const maxId = Number(rows[0].max_id);
  return { lastId: Math.min(requestedLastId, maxId), maxId };
}
