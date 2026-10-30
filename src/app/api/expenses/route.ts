import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readSession } from "@/app/api/_lib/read-session";
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { intParam, likeEscape, dateParam } from "@/lib/api";

// Cross-group expense search for the current user.
export const GET = privateHandler(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  const text = likeEscape(q.get("q"));
  const groupId = intParam(q.get("groupId"));
  const categoryId = intParam(q.get("categoryId"));
  const payerId = intParam(q.get("payerId"));
  const friendId = intParam(q.get("friendId"));
  const from = dateParam(q.get("from"));
  const to = dateParam(q.get("to"));
  const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);

  const { rows: [rows] } = await readSession((userId) => [sql`
    SELECT e.id, e.group_id, g.name AS group_name, e.title, e.amount_cents, e.currency,
      e.converted_cents, e.expense_date, e.payer_id, p.display_name AS payer_name,
      c.name AS category_name, e.split_method
    FROM expenses e
    JOIN groups g ON g.id = e.group_id
    JOIN users p ON p.id = e.payer_id
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE e.group_id IN (SELECT group_id FROM group_members WHERE user_id = ${userId})
      AND (${text}::text IS NULL OR e.title ILIKE '%' || ${text} || '%' ESCAPE '\' OR e.notes ILIKE '%' || ${text} || '%' ESCAPE '\')
      AND (${groupId}::bigint IS NULL OR e.group_id = ${groupId})
      AND (${categoryId}::bigint IS NULL OR e.category_id = ${categoryId})
      AND (${payerId}::bigint IS NULL OR e.payer_id = ${payerId})
      AND (${friendId}::bigint IS NULL OR EXISTS
        (SELECT 1 FROM expense_shares es WHERE es.expense_id = e.id AND es.user_id = ${friendId}))
      AND (${from}::date IS NULL OR e.expense_date >= ${from}::date)
      AND (${to}::date IS NULL OR e.expense_date <= ${to}::date)
    ORDER BY e.expense_date DESC, e.id DESC
    LIMIT ${limit + 1}`]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return privateJson(req, {
    hasMore,
    expenses: page.map((e) => ({
      id: Number(e.id),
      groupId: Number(e.group_id),
      groupName: e.group_name,
      title: e.title,
      amountCents: Number(e.amount_cents),
      currency: e.currency,
      convertedCents: Number(e.converted_cents),
      date: e.expense_date,
      payerId: Number(e.payer_id),
      payerName: e.payer_name,
      categoryName: e.category_name,
      splitMethod: e.split_method,
    })),
  });
});
