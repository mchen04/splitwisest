import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readSession } from "@/app/api/_lib/read-session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler, badRequest, forbidden, intParam } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { recordDirectSettlement, settlementFields } from "@/lib/settlements";
import { canSettleDirectly } from "@/lib/relationships";
import { versionToken } from "@/lib/versions";

// Payment history involving the caller, optionally narrowed to one friend.
export const GET = privateHandler(async (req: NextRequest) => {
  const friendId = intParam(req.nextUrl.searchParams.get("friendId"));
  const { rows: [rows] } = await readSession((userId) => [sql`
    SELECT s.id, s.group_id, g.name AS group_name, s.payer_id, s.recipient_id,
      s.amount_cents, s.currency, s.settled_date, s.note, s.updated_at,
      to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_token,
      p.display_name AS payer_name, r.display_name AS recipient_name
    FROM settlements s
    LEFT JOIN groups g ON g.id = s.group_id
    JOIN users p ON p.id = s.payer_id JOIN users r ON r.id = s.recipient_id
    WHERE (s.payer_id = ${userId} OR s.recipient_id = ${userId})
      AND (${friendId}::bigint IS NULL OR s.payer_id = ${friendId} OR s.recipient_id = ${friendId})
      AND (s.group_id IS NULL OR EXISTS (
        SELECT 1 FROM group_members gm WHERE gm.group_id = s.group_id AND gm.user_id = ${userId}
      ))
    ORDER BY s.settled_date DESC, s.id DESC LIMIT 200`]);
  return privateJson(req, {
    settlements: rows.map((s) => ({
      id: Number(s.id),
      groupId: s.group_id === null ? null : Number(s.group_id),
      groupName: s.group_name,
      payerId: Number(s.payer_id),
      recipientId: Number(s.recipient_id),
      payerName: s.payer_name,
      recipientName: s.recipient_name,
      amountCents: Number(s.amount_cents),
      currency: s.currency,
      date: s.settled_date,
      note: s.note,
      updatedAt: versionToken(s.updated_at_token),
    })),
  });
});

// Direct (group-less) settlement between two friends.
const Body = z.object({
  friendId: z.number().int().positive(),
  direction: z.enum(["i-paid", "they-paid"]),
  settleFullBalance: z.boolean().optional().default(false),
  ...settlementFields,
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const body = Body.parse(await req.json());
  if (body.friendId === user.id) badRequest("Cannot settle with yourself");
  if (!(await canSettleDirectly(user.id, body.friendId))) forbidden("You are not friends with this user");

  const payerId = body.direction === "i-paid" ? user.id : body.friendId;
  const recipientId = body.direction === "i-paid" ? body.friendId : user.id;
  const settlement = await recordDirectSettlement(
    user.id,
    {
      payerId,
      recipientId,
      amountCents: body.amountCents,
      currency: body.currency,
      date: body.date,
      note: body.note,
    },
    body.settleFullBalance
  );
  return NextResponse.json({ id: settlement.id, updatedAt: settlement.updatedAt });
});
