import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { CURRENCIES } from "@/lib/fx";
import { createGroup } from "@/lib/groups";

export const GET = handler(async () => {
  const user = await requireUser();
  // One round-trip: the viewer's own net per group comes from a LATERAL over
  // group_balance_rows(g.id) filtered to this user, folded into the group-list
  // query — replacing the previous N+1 of one balance round-trip per group.
  const groups = await sql`
    SELECT g.id, g.name, g.currency, g.invite_code,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM expenses e WHERE e.group_id = g.id) AS expense_count,
      (SELECT COALESCE(MAX(m.id), 0) FROM messages m
        WHERE m.channel = 'group' AND m.group_id = g.id AND m.sender_id <> ${user.id}) AS last_message_id,
      COALESCE((SELECT rs.last_id FROM read_state rs
        WHERE rs.user_id = ${user.id} AND rs.scope = 'msg:group:' || g.id), 0) AS read_message_id,
      COALESCE(b.net_cents, 0) AS my_net_cents
    FROM groups g JOIN group_members gm ON gm.group_id = g.id
    LEFT JOIN LATERAL group_balance_rows(g.id) b ON b.user_id = ${user.id}
    WHERE gm.user_id = ${user.id}
    ORDER BY (SELECT MAX(a.id) FROM activity a WHERE a.group_id = g.id) DESC NULLS LAST, g.created_at DESC`;
  return NextResponse.json({
    groups: groups.map((g) => ({
      id: Number(g.id),
      name: g.name,
      currency: g.currency,
      inviteCode: g.invite_code,
      memberCount: Number(g.member_count),
      expenseCount: Number(g.expense_count),
      myNetCents: Number(g.my_net_cents),
      unreadMessages: Number(g.last_message_id) > Number(g.read_message_id) ? 1 : 0,
    })),
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
