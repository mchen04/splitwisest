import { readSession } from "@/app/api/_lib/read-session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler, notFound } from "@/lib/api";
import { sql } from "@/lib/db";
import { mapNotification } from "@/lib/notifications";

export const GET = handler(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const rawId = (await params).id;
  const { rows: [rows] } = await readSession((userId) => {
    const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(rawId);
    return [sql`SELECT * FROM notifications n WHERE id = ${id} AND user_id = ${userId} AND notification_visible(n)`];
  });
  if (!rows[0]) notFound("This notification is no longer available");
  const notification = mapNotification(rows[0]);
  const target = new URL(notification.href, "https://splitwisest.invalid");
  const expenseId = target.searchParams.get("expense");
  if (expenseId && rows[0].group_id) {
    const expense = await sql`SELECT 1 FROM expenses WHERE id = ${expenseId} AND group_id = ${rows[0].group_id}`;
    if (!expense.length) notification.href = `/groups/${rows[0].group_id}?tab=activity`;
  }
  return NextResponse.json({ notification }, { headers: { "Cache-Control": "private, no-store" } });
});
