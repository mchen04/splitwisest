import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handler, intParam, likeEscape, dateParam } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { createExpenseWithActivity, ExpenseBody, materializeRecurring } from "@/lib/expenses";
import { finishGroupExpensePage, groupExpensePage } from "@/lib/group-expense-page";
import { parseGroupId, requireGroupMember } from "@/lib/groups";
import { versionToken } from "@/lib/versions";
import { currencyStep } from "@/lib/currencies";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  const group = await requireGroupMember(groupId, user.id);
  const step = currencyStep(group.currency);
  await materializeRecurring(groupId);

  const q = req.nextUrl.searchParams;
  const text = likeEscape(q.get("q"));
  const categoryId = intParam(q.get("categoryId"));
  const payerId = intParam(q.get("payerId"));
  const from = dateParam(q.get("from"));
  const to = dateParam(q.get("to"));
  // Lists use bounded pages. Insights request the complete, unfiltered history.
  const pageRequest = groupExpensePage(q);

  if (pageRequest.complete) {
    const rows = await sql`
      SELECT e.converted_cents, e.expense_date, p.display_name AS payer_name,
        c.name AS category_name
      FROM expenses e
      JOIN users p ON p.id = e.payer_id
      LEFT JOIN categories c ON c.id = e.category_id
      WHERE e.group_id = ${groupId}`;
    return NextResponse.json({
      hasMore: false,
      expenses: rows.map((e) => ({
        convertedCents: Number(e.converted_cents),
        date: e.expense_date,
        payerName: e.payer_name,
        categoryName: e.category_name,
      })),
    });
  }

  const rows = await sql`
    SELECT e.id, e.title, e.amount_cents, e.currency, e.converted_cents, e.expense_date,
      e.payer_id,
      to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_token,
      p.display_name AS payer_name, c.name AS category_name,
      (SELECT COUNT(*) FROM attachments a WHERE a.expense_id = e.id) AS attachment_count,
      (SELECT json_agg(json_build_object('userId', a.user_id, 'shareCents', a.share_cents,
        'convertedShareCents', a.converted_share_cents))
        FROM (
          -- Per-expense largest-remainder allocation so displayed converted shares
          -- sum EXACTLY to converted_cents (matches group_balance_rows()).
          SELECT es.user_id, es.share_cents,
            ((div(es.share_cents::numeric * e.converted_cents, e.amount_cents::numeric * ${step})
              + CASE WHEN row_number() OVER (
                    ORDER BY mod(es.share_cents::numeric * e.converted_cents, e.amount_cents::numeric * ${step}) DESC, es.user_id)
                  <= e.converted_cents / ${step} - sum(div(es.share_cents::numeric * e.converted_cents, e.amount_cents::numeric * ${step})) OVER ()
                THEN 1 ELSE 0 END) * ${step})::bigint AS converted_share_cents
          FROM expense_shares es WHERE es.expense_id = e.id
        ) a) AS shares
    FROM expenses e
    JOIN users p ON p.id = e.payer_id
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE e.group_id = ${groupId}
      AND (${text}::text IS NULL OR e.title ILIKE '%' || ${text} || '%' ESCAPE '\' OR e.notes ILIKE '%' || ${text} || '%' ESCAPE '\')
      AND (${categoryId}::bigint IS NULL OR e.category_id = ${categoryId})
      AND (${payerId}::bigint IS NULL OR e.payer_id = ${payerId})
      AND (${from}::date IS NULL OR e.expense_date >= ${from}::date)
      AND (${to}::date IS NULL OR e.expense_date <= ${to}::date)
    ORDER BY e.expense_date DESC, e.id DESC
    LIMIT ${pageRequest.sqlLimit ?? pageRequest.limit + 1} OFFSET ${pageRequest.offset}`;

  const page = finishGroupExpensePage(rows, pageRequest);

  return NextResponse.json({
    hasMore: page.hasMore,
    expenses: page.items.map((e) => ({
      id: Number(e.id),
      title: e.title,
      amountCents: Number(e.amount_cents),
      currency: e.currency,
      convertedCents: Number(e.converted_cents),
      date: e.expense_date,
      payerId: Number(e.payer_id),
      payerName: e.payer_name,
      categoryName: e.category_name,
      updatedAt: versionToken(e.updated_at_token),
      attachmentCount: Number(e.attachment_count),
      shares: e.shares ?? [],
    })),
  });
});

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  const group = await requireGroupMember(groupId, user.id);

  const input = ExpenseBody.parse(await req.json());
  const expenseId = await createExpenseWithActivity(groupId, group.currency, user, input);
  return NextResponse.json({ id: expenseId });
});
