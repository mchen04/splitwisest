import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler, notFound } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { CURRENCIES } from "@/lib/fx";
import { requireGroupMember } from "@/lib/groups";
import { stopRecurringExpenseWithActivity, updateRecurringExpenseWithActivity } from "@/lib/expenses";
import { VersionToken } from "@/lib/versions";

type Ctx = { params: Promise<{ id: string }> };

const PatchBody = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
  amountCents: z.number().int().positive().max(100_000_000_000),
  currency: z.string().refine((c) => CURRENCIES.includes(c), "Unsupported currency"),
  unitId: z.number().int().positive().nullable().optional(),
  payerId: z.number().int().positive(),
  categoryId: z.number().int().positive().nullable().optional(),
  participantIds: z.array(z.number().int().positive()).min(1, "At least one participant"),
  notes: z.string().max(2000).default(""),
  cadence: z.enum(["weekly", "monthly"]),
  nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  active: z.boolean().default(true),
  expectedUpdatedAt: VersionToken,
});

// Edit a recurring rule in place. Future materializations pick up the new
// values; expenses already generated from it are left untouched.
export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const rows = await sql`SELECT group_id FROM recurring_expenses WHERE id = ${id}`;
  if (rows.length === 0) notFound();
  const groupId = Number(rows[0].group_id);
  await requireGroupMember(groupId, user.id);
  const body = PatchBody.parse(await req.json());
  const updated = await updateRecurringExpenseWithActivity(id, groupId, user, body);
  return NextResponse.json({ ok: true, updatedAt: updated.updatedAt });
});

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const rows = await sql`SELECT group_id, title FROM recurring_expenses WHERE id = ${id}`;
  if (rows.length === 0) notFound();
  const groupId = Number(rows[0].group_id);
  await requireGroupMember(groupId, user.id);
  const expectedUpdatedAt = VersionToken.parse(req.nextUrl.searchParams.get("expectedUpdatedAt") ?? "");
  await stopRecurringExpenseWithActivity(id, groupId, rows[0].title, user, expectedUpdatedAt);
  return NextResponse.json({ ok: true });
});
