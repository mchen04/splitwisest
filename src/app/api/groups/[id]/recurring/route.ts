import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readGroup } from "@/app/api/_lib/read-group";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { CURRENCIES } from "@/lib/fx";
import { parseGroupId, requireGroupMember } from "@/lib/groups";
import { createRecurringExpenseWithActivity } from "@/lib/expenses";
import { versionToken } from "@/lib/versions";

type Ctx = { params: Promise<{ id: string }> };

export const GET = privateHandler(async (req: NextRequest, { params }: Ctx) => {
  const { rows: [rows] } = await readGroup((await params).id, (groupId) => [sql`
    SELECT r.*, to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_token,
      u.display_name AS payer_name, c.name AS category_name
    FROM recurring_expenses r
    JOIN users u ON u.id = r.payer_id
    LEFT JOIN categories c ON c.id = r.category_id
    WHERE r.group_id = ${groupId} ORDER BY r.id`]);
  return privateJson(req, {
    recurring: rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      amountCents: Number(r.amount_cents),
      currency: r.currency,
      payerId: Number(r.payer_id),
      payerName: r.payer_name,
      categoryId: r.category_id ? Number(r.category_id) : null,
      categoryName: r.category_name,
      participantIds: (r.participant_ids as number[]).map(Number),
      notes: r.notes,
      cadence: r.cadence,
	      nextDate: r.next_date,
	      anchorDay: r.anchor_day ? Number(r.anchor_day) : null,
	      active: r.active,
	      updatedAt: versionToken(r.updated_at_token),
	    })),
  });
});

const Body = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
  amountCents: z.number().int().positive().max(100_000_000_000),
  currency: z.string().refine((c) => CURRENCIES.includes(c), "Unsupported currency"),
  payerId: z.number().int().positive(),
  categoryId: z.number().int().positive().nullable().optional(),
  participantIds: z.array(z.number().int().positive()).min(1, "At least one participant"),
  notes: z.string().max(2000).default(""),
  cadence: z.enum(["weekly", "monthly"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
});

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  await requireGroupMember(groupId, user.id);
  const body = Body.parse(await req.json());
  const id = await createRecurringExpenseWithActivity(groupId, user, body);
  return NextResponse.json({ id });
});
