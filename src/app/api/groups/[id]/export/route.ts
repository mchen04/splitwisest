import { readGroup } from "@/app/api/_lib/read-group";
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { handler } from "@/lib/api";
import { currencyFractionDigits } from "@/lib/currencies";
import { formatUnitQuantity } from "@/lib/units";

type Ctx = { params: Promise<{ id: string }> };

function csvCell(v: unknown): string {
  const raw = String(v ?? "").replace(/\r\n?/g, "\n");
  const s = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {

  const { group, rows: [rows] } = await readGroup((await params).id, (groupId) => [sql`
    SELECT to_char(e.expense_date, 'YYYY-MM-DD') AS expense_date, e.title, e.amount_cents, e.currency, e.converted_cents,
      e.unit_id, gu.name AS unit_name,
      p.display_name AS payer, c.name AS category, e.split_method, e.notes,
      (SELECT string_agg(u.display_name || ': ' || CASE WHEN e.unit_id IS NULL THEN to_char(
            es.share_cents/100.0,
            CASE WHEN e.currency IN ('JPY','KRW') THEN 'FM999999999999999990' ELSE 'FM999999999999999990.00' END
          ) ELSE rtrim(rtrim(to_char(es.share_cents/100.0, 'FM999999999999999990.00'), '0'), '.') END,
          '; ' ORDER BY u.display_name)
       FROM expense_shares es JOIN users u ON u.id = es.user_id WHERE es.expense_id = e.id) AS shares
    FROM expenses e
    JOIN users p ON p.id = e.payer_id
    LEFT JOIN categories c ON c.id = e.category_id
    LEFT JOIN group_units gu ON gu.id = e.unit_id
    WHERE e.group_id = ${groupId}
    ORDER BY e.expense_date, e.id`]);
  const header = ["Date", "Title", "Amount", "Currency", `Amount (${group.currency})`, "Paid by", "Category", "Split", "Notes", "Shares", "Unit"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const unitName = r.unit_name as string | null;
    const unit = r.unit_id !== null;
    lines.push([
      r.expense_date,
      csvCell(r.title),
      unit ? formatUnitQuantity(Number(r.amount_cents)) : (Number(r.amount_cents) / 100).toFixed(currencyFractionDigits(r.currency as string)),
      unit ? "" : r.currency,
      unit ? "" : (Number(r.converted_cents) / 100).toFixed(currencyFractionDigits(group.currency)),
      csvCell(r.payer),
      csvCell(r.category ?? ""),
      r.split_method,
      csvCell(r.notes),
      csvCell(r.shares ?? ""),
      csvCell(unitName ?? ""),
    ].join(","));
  }
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${group.name.replace(/[^a-z0-9-_ ]/gi, "")}-expenses.csv"`,
    },
  });
});
