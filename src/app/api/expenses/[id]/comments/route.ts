import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readSession } from "@/app/api/_lib/read-session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler, notFound, forbidden } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { isGroupMember } from "@/lib/balances";
import { assertExpenseAccess, insertExpenseComment } from "@/lib/expenses";

type Ctx = { params: Promise<{ id: string }> };

async function requireExpenseAccess(expenseId: number, userId: number) {
  const rows = await sql`SELECT group_id FROM expenses WHERE id = ${expenseId}`;
  if (rows.length === 0) notFound("Expense not found");
  if (!(await isGroupMember(Number(rows[0].group_id), userId))) forbidden();
}

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
      SELECT c.id, c.author_id, c.body, c.created_at, u.display_name
      FROM expense_comments c JOIN users u ON u.id = c.author_id
      WHERE c.expense_id = ${id} ORDER BY c.id ASC`,
  ]);
  assertExpenseAccess(access);
  return privateJson(req, {
    comments: rows.map((c) => ({
      id: Number(c.id),
      authorId: Number(c.author_id),
      authorName: c.display_name,
      body: c.body,
      createdAt: c.created_at,
    })),
  });
});

const Body = z.object({ body: z.string().trim().min(1, "Comment is empty").max(2000) });

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  await requireExpenseAccess(id, user.id);
  const { body } = Body.parse(await req.json());
  const inserted = await insertExpenseComment(id, user, body);
  if (inserted === null) forbidden();
  return NextResponse.json({
    comment: {
      id: inserted.id,
      authorId: user.id,
      authorName: user.displayName,
      body,
      createdAt: inserted.createdAt,
    },
  });
});
