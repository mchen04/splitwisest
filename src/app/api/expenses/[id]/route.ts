import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handler, notFound, forbidden } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { isGroupMember } from "@/lib/balances";
import {
  assertExpenseAccess, deleteExpenseWithActivity, EXPENSE_READ, ExpenseBody, updateExpenseByIdWithActivity,
} from "@/lib/expenses";
import { versionToken } from "@/lib/versions";

type Ctx = { params: Promise<{ id: string }> };

async function loadExpense(id: number, userId: number) {
  const rows = await sql`
    SELECT e.*, to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_token
    FROM expenses e
    WHERE e.id = ${id}`;
  if (rows.length === 0) notFound("Expense not found");
  const e = rows[0];
  if (!(await isGroupMember(Number(e.group_id), userId))) forbidden();
  return e;
}

export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const [rows, shares, items, attachments] = await sql.transaction((tx) => [
    tx`
      SELECT e.*, to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_token,
        EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = e.group_id AND gm.user_id = ${user.id}) AS is_member
      FROM expenses e
      WHERE e.id = ${id}`,
    tx`
      SELECT es.user_id, es.share_cents, es.raw_input, u.display_name
      FROM expense_shares es JOIN users u ON u.id = es.user_id WHERE es.expense_id = ${id}`,
    tx`SELECT id, name, amount_cents, participant_ids FROM expense_items WHERE expense_id = ${id} ORDER BY id`,
    tx`SELECT id, filename, mime FROM attachments WHERE expense_id = ${id} ORDER BY id`,
  ], EXPENSE_READ);
  assertExpenseAccess(rows);
  const e = rows[0];
  return NextResponse.json({
    expense: {
      id,
      groupId: Number(e.group_id),
      title: e.title,
      amountCents: Number(e.amount_cents),
      currency: e.currency,
      convertedCents: Number(e.converted_cents),
      date: e.expense_date,
      payerId: Number(e.payer_id),
      categoryId: e.category_id ? Number(e.category_id) : null,
      notes: e.notes,
      splitMethod: e.split_method,
      updatedAt: versionToken(e.updated_at_token),
      itemizedTaxCents: Number(e.itemized_tax_cents ?? 0),
      itemizedTipCents: Number(e.itemized_tip_cents ?? 0),
      shares: shares.map((s) => ({
        userId: Number(s.user_id),
        shareCents: Number(s.share_cents),
        rawInput: s.raw_input === null ? null : Number(s.raw_input),
        displayName: s.display_name,
      })),
      items: items.map((i) => ({
        id: Number(i.id),
        name: i.name,
        amountCents: Number(i.amount_cents),
        participantIds: (i.participant_ids as number[]).map(Number),
      })),
      attachments: attachments.map((a) => ({ id: Number(a.id), filename: a.filename, mime: a.mime })),
    },
  });
});

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const input = ExpenseBody.parse(await req.json());
  await updateExpenseByIdWithActivity(id, user, input);
  return NextResponse.json({ ok: true });
});

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const e = await loadExpense(id, user.id);
  const expectedUpdatedAt = req.nextUrl.searchParams.get("expectedUpdatedAt") ?? undefined;
  await deleteExpenseWithActivity({
    id,
    groupId: Number(e.group_id),
    title: e.title,
    amountCents: Number(e.amount_cents),
    currency: e.currency,
    expectedUpdatedAt,
  }, user);
  return NextResponse.json({ ok: true });
});
