import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readSession } from "@/app/api/_lib/read-session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { CURRENCIES } from "@/lib/fx";
import { createGroup } from "@/lib/groups";
import { computeUnitBalances, parseUnitLedger } from "@/lib/units";

export const GET = privateHandler(async (req?: NextRequest) => {
  // One round-trip: the viewer's own net per group comes from a LATERAL over
  // group_balance_rows(g.id) filtered to this user, folded into the group-list
  // query — replacing the previous N+1 of one balance round-trip per group.
  const { user, rows: [groups] } = await readSession((userId) => [sql`
    SELECT g.id, g.name, g.currency, g.invite_code, g.auto_reconcile_units,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM expenses e WHERE e.group_id = g.id) AS expense_count,
      (SELECT COALESCE(MAX(m.id), 0) FROM messages m
        WHERE m.channel = 'group' AND m.group_id = g.id AND m.sender_id <> ${userId}) AS last_message_id,
      COALESCE((SELECT rs.last_id FROM read_state rs
        WHERE rs.user_id = ${userId} AND rs.scope = 'msg:group:' || g.id), 0) AS read_message_id,
      COALESCE(b.net_cents, 0) AS my_net_cents
      , COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'unitId', gu.id, 'name', gu.name,
          'expenses', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'payerId', e.payer_id, 'amountCents', e.amount_cents,
              'shares', COALESCE((
                SELECT jsonb_agg(jsonb_build_object('userId', es.user_id, 'shareCents', es.share_cents))
                FROM expense_shares es WHERE es.expense_id = e.id
              ), '[]'::jsonb)
            ))
            FROM expenses e WHERE e.group_id = gu.group_id AND e.unit_id = gu.id
          ), '[]'::jsonb),
          'settlements', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'payerId', s.payer_id, 'recipientId', s.recipient_id, 'amountCents', s.amount_cents))
            FROM settlements s WHERE s.group_id = gu.group_id AND s.unit_id = gu.id
          ), '[]'::jsonb)
        ) ORDER BY gu.name, gu.id)
        FROM group_units gu WHERE gu.group_id = g.id
      ), '[]'::jsonb) AS unit_ledger
    FROM groups g JOIN group_members gm ON gm.group_id = g.id
    LEFT JOIN LATERAL group_balance_rows(g.id) b ON b.user_id = ${userId}
    WHERE gm.user_id = ${userId}
    ORDER BY (SELECT MAX(a.id) FROM activity a WHERE a.group_id = g.id) DESC NULLS LAST, g.created_at DESC`]);
  return privateJson(req, {
    groups: groups.map((g) => {
      const unitNets = parseUnitLedger(g.unit_ledger).map((unit) => {
        const memberIds = new Set<number>();
        for (const expense of unit.expenses) {
          memberIds.add(expense.payerId);
          for (const share of expense.shares) memberIds.add(share.userId);
        }
        for (const settlement of unit.settlements) {
          memberIds.add(settlement.payerId);
          memberIds.add(settlement.recipientId);
        }
        memberIds.add(user.id);
        const result = computeUnitBalances(memberIds, unit.expenses, unit.settlements, Boolean(g.auto_reconcile_units));
        return {
          unitId: unit.unitId,
          name: unit.name,
          netCents: result.nets.find((row) => row.userId === user.id)?.netCents ?? 0,
        };
      }).filter((row) => row.netCents !== 0);
      return {
        id: Number(g.id),
        name: g.name,
        currency: g.currency,
        inviteCode: g.invite_code,
        memberCount: Number(g.member_count),
        expenseCount: Number(g.expense_count),
        myNetCents: Number(g.my_net_cents),
        unitNets,
        unreadMessages: Number(g.last_message_id) > Number(g.read_message_id) ? 1 : 0,
      };
    }),
  });
});

const CreateBody = z.object({
  name: z.string().trim().min(1, "Group name is required").max(60),
  currency: z.string().refine((c) => CURRENCIES.includes(c), "Unsupported currency"),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const { name, currency } = CreateBody.parse(await req.json());
  const group = await createGroup(user, name, currency);
  return NextResponse.json({ id: group.id, inviteCode: group.inviteCode });
});
