import { sql } from "./db";
import { pairwiseFriendObligations } from "./balances";
import type { FriendObligation } from "./balances";
import { loadRelationship, RelationshipState } from "./relationships";
import { loadVisibleSettlementHistory } from "./settlements";

export interface PersonProfile {
  person: {
    id: number;
    displayName: string;
    username: string;
  };
  relationship: RelationshipState;
  request: null | {
    id: number;
    direction: "incoming" | "outgoing";
    createdAt: string;
  };
  sharedGroups: {
    id: number;
    name: string;
    currency: string;
  }[];
  netByCurrency: Record<string, number>;
  obligations: FriendObligation[];
  recentExpenses: {
    id: number;
    groupId: number;
    groupName: string;
    title: string;
    amountCents: number;
    currency: string;
    unitId: number | null;
    unitName: string | null;
    date: string;
    payerId: number;
    payerName: string;
  }[];
  recentPayments: {
    id: number;
    groupId: number | null;
    groupName: string | null;
    payerId: number;
    payerName: string;
    recipientId: number;
    recipientName: string;
    amountCents: number;
    currency: string;
    unitId: number | null;
    unitName: string | null;
    date: string;
    note: string;
  }[];
  canChat: boolean;
  canSettleDirectly: boolean;
  canNudge: boolean;
  canRequestFriend: boolean;
  canRemoveFriend: boolean;
}

export async function loadPersonProfile(viewerId: number, personId: number): Promise<PersonProfile | null> {
  // The user row and the relationship both depend only on the two ids — load them
  // in parallel instead of serially.
  const [users, rel] = await Promise.all([
    sql`SELECT id, display_name, username FROM users WHERE id = ${personId}`,
    loadRelationship(viewerId, personId),
  ]);
  if (users.length === 0) return null;

  const person = {
    id: Number(users[0].id),
    displayName: users[0].display_name,
    username: users[0].username,
  };

  const { relationship, isSelf, isFriend, request, sharedGroups, capabilities } = rel;

  if (relationship === "none") return null;

  if (relationship === "pending") {
    return {
      person,
      relationship,
      request,
      sharedGroups: [],
      netByCurrency: {},
      obligations: [],
      recentExpenses: [],
      recentPayments: [],
      canChat: false,
      canSettleDirectly: false,
      canNudge: false,
      canRequestFriend: false,
      canRemoveFriend: false,
    };
  }

  const groupIds = sharedGroups.map((g) => Number(g.id));

  // Obligations, expenses, and payment history can load at the same time.
  const [obligations, recentExpenses, recentPayments] = await Promise.all([
    isSelf ? Promise.resolve([] as FriendObligation[]) : pairwiseFriendObligations(viewerId, personId),
    groupIds.length === 0 ? Promise.resolve([] as Record<string, unknown>[]) : sql`
    SELECT e.id, e.group_id, g.name AS group_name, e.title, e.converted_cents, g.currency,
      e.unit_id, gu.name AS unit_name,
      e.expense_date, e.payer_id, p.display_name AS payer_name
    FROM expenses e
    JOIN groups g ON g.id = e.group_id
    LEFT JOIN group_units gu ON gu.id = e.unit_id
    JOIN users p ON p.id = e.payer_id
    WHERE e.group_id = ANY(${groupIds})
      AND (
        e.payer_id = ${personId}
        OR EXISTS (
          SELECT 1 FROM expense_shares es
          WHERE es.expense_id = e.id AND es.user_id = ${personId} AND es.share_cents > 0
        )
      )
    ORDER BY e.expense_date DESC, e.id DESC
    LIMIT 20`,
    loadVisibleSettlementHistory({ viewerId, personId, isSelf, isFriend, groupIds }),
  ]);
  const netByCurrency = obligations.reduce<Record<string, number>>((net, obligation) => {
    if (obligation.kind === "unit") return net;
    net[obligation.currency] = (net[obligation.currency] ?? 0) + obligation.netCents;
    if (net[obligation.currency] === 0) delete net[obligation.currency];
    return net;
  }, {});

  return {
    person,
    relationship,
    request,
    sharedGroups: sharedGroups.map((g) => ({
      id: Number(g.id),
      name: g.name,
      currency: g.currency,
    })),
    netByCurrency,
    obligations,
    recentExpenses: recentExpenses.map((e) => ({
      id: Number(e.id),
      groupId: Number(e.group_id),
      groupName: e.group_name,
      title: e.title,
      amountCents: Number(e.converted_cents),
      currency: e.currency,
      unitId: e.unit_id === null ? null : Number(e.unit_id),
      unitName: (e.unit_name as string | null) ?? null,
      date: e.expense_date,
      payerId: Number(e.payer_id),
      payerName: e.payer_name,
    })),
    recentPayments,
    ...capabilities(obligations.length > 0),
  };
}
