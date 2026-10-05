import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { badRequest, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { parseGroupId, requireGroupMember, requireGroupViewerVersions } from "@/lib/groups";
import { createGroupObligation } from "@/lib/group-obligations";
import { GroupObligationCreateBody } from "@/lib/group-obligation-math";
import { versionToken } from "@/lib/versions";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id: groupId, versions } = await requireGroupViewerVersions((await params).id);
  const rawLimit = req.nextUrl.searchParams.get("limit");
  const requested = rawLimit === null || rawLimit.trim() === "" ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(requested)) badRequest("Invalid page limit");
  const limit = Math.min(Math.max(requested || 50, 1), 200);
  const beforeRaw = req.nextUrl.searchParams.get("before");
  const before = beforeRaw === null ? null : Number(beforeRaw);
  if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) badRequest("Invalid page cursor");
  const rows = await sql`
    WITH page AS (
      SELECT id, title, amount_cents,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_token
      FROM group_obligations WHERE group_id = ${groupId}
        AND (${before}::bigint IS NULL OR id < ${before}::bigint)
      ORDER BY id DESC LIMIT ${limit + 1}
    )
    SELECT
      (SELECT COALESCE(MAX(id), 0) FROM activity
       WHERE group_id = ${groupId}
         AND type IN ('group_balance.added', 'group_balance.edited', 'group_balance.deleted')) AS change_cursor,
      (SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY page.id DESC), '[]'::jsonb) FROM page) AS balances`;
  const listed = rows[0].balances as { id: number; title: string; amount_cents: number; updated_at_token: string }[];
  return NextResponse.json({ version: versions.list, changeCursor: Number(rows[0].change_cursor), hasMore: listed.length > limit, balances: listed.slice(0, limit).map((r) => ({
    id: Number(r.id), title: r.title, amountCents: Number(r.amount_cents),
    updatedAt: versionToken(r.updated_at_token),
  })) });
});

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  const group = await requireGroupMember(groupId, user.id);
  const input = GroupObligationCreateBody.parse(await req.json());
  const id = await createGroupObligation(groupId, group.currency, user, input);
  return NextResponse.json({ id });
});
