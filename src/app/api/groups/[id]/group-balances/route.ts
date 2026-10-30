import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { badRequest, forbidden, handler, notFound } from "@/lib/api";
import { AuthError, markSessionOwner, requireSessionToken, requireUser } from "@/lib/auth";
import { parseGroupId, requireGroupMember } from "@/lib/groups";
import { createGroupObligation } from "@/lib/group-obligations";
import { GroupObligationCreateBody } from "@/lib/group-obligation-math";
import { versionToken } from "@/lib/versions";

type Ctx = { params: Promise<{ id: string }> };

export const GET = privateHandler(async (req: NextRequest, { params }: Ctx) => {
  const token = await requireSessionToken();
  const rawId = (await params).id;
  if (!Number.isInteger(Number(rawId))) await requireUser();
  const groupId = parseGroupId(rawId);
  const rawLimit = req.nextUrl.searchParams.get("limit");
  const requested = rawLimit === null || rawLimit.trim() === "" ? 50 : Number(rawLimit);
  const limit = Number.isSafeInteger(requested) ? Math.min(Math.max(requested || 50, 1), 200) : 50;
  const beforeRaw = req.nextUrl.searchParams.get("before");
  const requestedBefore = beforeRaw === null ? null : Number(beforeRaw);
  const validBefore = requestedBefore === null || (Number.isSafeInteger(requestedBefore) && requestedBefore > 0);
  const before = validBefore ? requestedBefore : null;
  const rows = await sql`
    WITH viewer AS (
      SELECT s.user_id AS id FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ${token} AND s.expires_at > now() AND u.deleted_at IS NULL
    ),
    group_viewer AS MATERIALIZED (
      SELECT v.viewer_id, g.id,
        EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = v.viewer_id) AS is_member
      FROM (SELECT (SELECT id FROM viewer) AS viewer_id) v
      LEFT JOIN groups g ON g.id = ${groupId}
    ),
    visible_group AS (
      SELECT id FROM group_viewer WHERE is_member
    ),
    changes AS MATERIALIZED (
      SELECT MAX(id) AS cursor FROM activity WHERE group_id = (SELECT id FROM visible_group)
        AND type IN ('group_balance.added', 'group_balance.edited', 'group_balance.deleted')
    ),
    page AS (
      SELECT id, title, amount_cents,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_token
      FROM group_obligations WHERE group_id = (SELECT id FROM visible_group)
        AND (${before}::bigint IS NULL OR id < ${before}::bigint)
      ORDER BY id DESC LIMIT ${limit + 1}
    )
    SELECT g.*,
      CASE WHEN g.is_member THEN md5(jsonb_build_array(
        (SELECT jsonb_agg(jsonb_build_array(o.id, o.title, o.amount_cents, o.updated_at) ORDER BY o.id)
         FROM group_obligations o WHERE o.group_id = g.id),
        (SELECT cursor FROM changes))::text) END AS list_version,
      (SELECT COALESCE(cursor, 0) FROM changes) AS change_cursor,
      (SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY page.id DESC), '[]'::jsonb) FROM page) AS balances
    FROM group_viewer g`;
  if (rows[0].viewer_id === null) throw new AuthError();
  await markSessionOwner(Number(rows[0].viewer_id));
  if (rows[0].id === null) notFound();
  if (!rows[0].is_member) forbidden("You are not a member of this group");
  if (!Number.isSafeInteger(requested)) badRequest("Invalid page limit");
  if (!validBefore) badRequest("Invalid page cursor");
  const listed = rows[0].balances as { id: number; title: string; amount_cents: number; updated_at_token: string }[];
  return privateJson(req, { version: rows[0].list_version, changeCursor: Number(rows[0].change_cursor), hasMore: listed.length > limit, balances: listed.slice(0, limit).map((r) => ({
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
