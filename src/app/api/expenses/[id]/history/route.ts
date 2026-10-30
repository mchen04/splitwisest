import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readSession } from "@/app/api/_lib/read-session";
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { notFound } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { activityChanges } from "@/lib/activity";
import { assertExpenseAccess } from "@/lib/expenses";

type Ctx = { params: Promise<{ id: string }> };

export const GET = privateHandler(async (req: NextRequest, { params }: Ctx) => {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) {
    await requireUser();
    notFound();
  }
  const { rows: [access, rows] } = await readSession((userId) => [
    sql`SELECT e.group_id,
      EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = e.group_id AND gm.user_id = ${userId}) AS is_member
      FROM expenses e WHERE e.id = ${id}`,
    sql`
      SELECT a.id, a.actor_id, a.created_at, a.data, u.display_name
      FROM activity a JOIN users u ON u.id = a.actor_id
      WHERE a.type = 'expense.edited'
        AND a.data->>'expenseId' = ${String(id)}
      ORDER BY a.id DESC
      LIMIT 50`,
  ]);
  assertExpenseAccess(access);

  // Edits made before change detail was recorded carry no diff; they are left out
  // rather than rendered as an empty entry.
  const edits = rows
    .map((r) => ({
      id: Number(r.id),
      actorId: Number(r.actor_id),
      actorName: r.display_name as string,
      createdAt: r.created_at as string,
      changes: activityChanges(r.data),
    }))
    .filter((e) => e.changes.length > 0);

  return privateJson(req, { edits });
});
