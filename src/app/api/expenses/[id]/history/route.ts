import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handler, notFound } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { activityChanges } from "@/lib/activity";
import { assertExpenseAccess, EXPENSE_READ, expenseAccessQuery } from "@/lib/expenses";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const [access, rows] = await sql.transaction((tx) => [
    expenseAccessQuery(tx, id, user.id),
    tx`
      SELECT a.id, a.actor_id, a.created_at, a.data, u.display_name
      FROM activity a JOIN users u ON u.id = a.actor_id
      WHERE a.type = 'expense.edited'
        AND a.data->>'expenseId' = ${String(id)}
      ORDER BY a.id DESC
      LIMIT 50`,
  ], EXPENSE_READ);
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

  return NextResponse.json({ edits });
});
