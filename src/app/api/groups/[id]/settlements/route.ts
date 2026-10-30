import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readGroup } from "@/app/api/_lib/read-group";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler, badRequest } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { recordGroupSettlement, settlementFields } from "@/lib/settlements";
import { parseGroupId, requireGroupMember } from "@/lib/groups";
import { versionToken } from "@/lib/versions";
import { groupBalances, suggestSettlements } from "@/lib/balances";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  payerId: z.number().int().positive(),
  recipientId: z.number().int().positive(),
  settleFullBalance: z.boolean().optional().default(false),
  ...settlementFields,
});

export const GET = privateHandler(async (req: NextRequest, { params }: Ctx) => {
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 50, 1), 200);
  const { rows: [rows] } = await readGroup((await params).id, (groupId) => [sql`
    SELECT s.id, s.payer_id, s.recipient_id, s.amount_cents, s.currency, s.converted_cents,
      s.settled_date, s.note, s.updated_at,
      to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_token,
      p.display_name AS payer_name, r.display_name AS recipient_name
    FROM settlements s
    JOIN users p ON p.id = s.payer_id JOIN users r ON r.id = s.recipient_id
    WHERE s.group_id = ${groupId} ORDER BY s.settled_date DESC, s.id DESC LIMIT ${limit + 1}`]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return privateJson(req, {
    hasMore,
    settlements: page.map((s) => ({
      id: Number(s.id),
      payerId: Number(s.payer_id),
      recipientId: Number(s.recipient_id),
      payerName: s.payer_name,
      recipientName: s.recipient_name,
      amountCents: Number(s.amount_cents),
      currency: s.currency,
      convertedCents: Number(s.converted_cents),
      date: s.settled_date,
      note: s.note,
      updatedAt: versionToken(s.updated_at_token),
    })),
  });
});

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  const group = await requireGroupMember(groupId, user.id);
  const body = Body.parse(await req.json());
  if (body.payerId === body.recipientId) badRequest("Payer and recipient must be different");
  let expectedBalances: [number, number][] | undefined;
  if (body.settleFullBalance) {
    const balances = await groupBalances(groupId);
    const transfer = suggestSettlements(balances).find(
      (item) => item.from === body.payerId && item.to === body.recipientId
    );
    if (!transfer || transfer.amountCents !== body.amountCents || body.currency !== group.currency) {
      badRequest("This balance changed. Refresh and try again");
    }
    expectedBalances = balances
      .map((item): [number, number] => [item.userId, item.netCents])
      .sort((a, b) => a[0] - b[0]);
  }
  const settlement = await recordGroupSettlement(groupId, group.currency, user.id, body, expectedBalances);
  return NextResponse.json({ id: settlement.id, updatedAt: settlement.updatedAt });
});
