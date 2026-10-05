import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler, notFound, forbidden } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { isGroupMember } from "@/lib/balances";
import { assertExpenseAccess, EXPENSE_READ, expenseAccessQuery, insertExpenseComment } from "@/lib/expenses";

type Ctx = { params: Promise<{ id: string }> };

async function requireExpenseAccess(expenseId: number, userId: number) {
  const rows = await sql`SELECT group_id FROM expenses WHERE id = ${expenseId}`;
  if (rows.length === 0) notFound("Expense not found");
  if (!(await isGroupMember(Number(rows[0].group_id), userId))) forbidden();
}

export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const [access, rows] = await sql.transaction((tx) => [
    expenseAccessQuery(tx, id, user.id),
    tx`
      SELECT c.id, c.author_id, c.body, c.created_at, u.display_name
      FROM expense_comments c JOIN users u ON u.id = c.author_id
      WHERE c.expense_id = ${id} ORDER BY c.id ASC`,
  ], EXPENSE_READ);
  assertExpenseAccess(access);
  return NextResponse.json({
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
