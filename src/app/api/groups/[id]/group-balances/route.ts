import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { badRequest, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { parseGroupId, requireGroupMember } from "@/lib/groups";
import { createGroupObligation } from "@/lib/group-obligations";
import { GroupObligationBody } from "@/lib/group-obligation-math";
import { versionToken } from "@/lib/versions";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  await requireGroupMember(groupId, user.id);
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 50, 1), 200);
  const beforeRaw = req.nextUrl.searchParams.get("before");
  const before = beforeRaw === null ? null : Number(beforeRaw);
  if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) badRequest("Invalid page cursor");
  const rows = await sql`
    SELECT id, title, amount_cents,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_token
    FROM group_obligations WHERE group_id = ${groupId}
      AND (${before}::bigint IS NULL OR id < ${before}::bigint)
    ORDER BY id DESC LIMIT ${limit + 1}`;
  return NextResponse.json({ hasMore: rows.length > limit, balances: rows.slice(0, limit).map((r) => ({
    id: Number(r.id), title: r.title, amountCents: Number(r.amount_cents),
    updatedAt: versionToken(r.updated_at_token),
  })) });
});

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  const group = await requireGroupMember(groupId, user.id);
  const input = GroupObligationBody.parse(await req.json());
  const id = await createGroupObligation(groupId, group.currency, user, input);
  return NextResponse.json({ id });
});
