import { sql } from "./db";
import type { NeonQueryFunctionInTransaction } from "@neondatabase/serverless";
import { simplifyDebts, Transfer } from "./money";
import { computeUnitBalances, parseUnitLedger } from "./units";

// All balance math uses converted_cents (the expense amount converted to the
// group's currency at entry time). Settlements likewise.

export interface MemberBalance {
  userId: number;
  displayName: string;
  netCents: number; // positive = is owed, negative = owes
}

export async function groupBalances(groupId: number): Promise<MemberBalance[]> {
  const rows = await sql`
    SELECT user_id, display_name, net_cents
    FROM group_balance_rows(${groupId})
    ORDER BY display_name, user_id`;
  return rows.map((r) => ({
    userId: Number(r.user_id),
    displayName: r.display_name,
    netCents: Number(r.net_cents),
  }));
}

export function suggestSettlements(balances: MemberBalance[]): Transfer[] {
  return simplifyDebts(new Map(balances.map((b) => [b.userId, b.netCents])));
}

export interface FriendObligation {
  groupId: number | null;
  groupName: string | null;
  currency: string;
  netCents: number; // positive = friend owes viewer, negative = viewer owes friend
  kind?: "money" | "unit";
  unitId?: number;
  unitName?: string;
}

export interface FriendBalance {
  friendId: number;
  displayName: string;
  username: string;
  obligations: FriendObligation[];
  netByCurrency: Record<string, number>;
}

export interface GroupBalanceSnapshot {
  groupId: number;
  balances: [number, number][];
}

export function netObligations(obligations: FriendObligation[]): Record<string, number> {
  const net: Record<string, number> = {};
  for (const obligation of obligations) {
    if (obligation.kind === "unit") continue;
    net[obligation.currency] = (net[obligation.currency] ?? 0) + obligation.netCents;
    if (net[obligation.currency] === 0) delete net[obligation.currency];
  }
  return net;
}

export async function friendGroupObligationsSnapshot(
  userId: number,
  onlyFriendId?: number
): Promise<{ byFriend: Map<number, FriendObligation[]>; snapshots: GroupBalanceSnapshot[] }> {
  const friendFilter = onlyFriendId ?? null;
  const groupRows = await friendGroupRows(userId, friendFilter);
  return groupObligationsSnapshot(groupRows, userId, friendFilter);
}

function friendGroupRows(
  userId: number,
  friendFilter: number | null,
  query: NeonQueryFunctionInTransaction<false, false> = sql
) {
  return query`
    SELECT g.id AS group_id, g.name AS group_name, g.currency, g.auto_reconcile_units,
      COALESCE((
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
      ), '[]'::jsonb) AS unit_ledger,
      b.user_id, b.display_name, b.net_cents
    FROM groups g
    JOIN group_members me ON me.group_id = g.id AND me.user_id = ${userId}
    CROSS JOIN LATERAL group_balance_rows(g.id) b
    WHERE ${friendFilter}::bigint IS NULL OR EXISTS (
      SELECT 1 FROM group_members them
      WHERE them.group_id = g.id AND them.user_id = ${friendFilter}
    )
    ORDER BY g.id, b.user_id`;
}

function groupObligationsSnapshot(
  groupRows: Record<string, unknown>[],
  userId: number,
  friendFilter: number | null
) {
  const byFriend = new Map<number, FriendObligation[]>();
  const grouped = new Map<number, typeof groupRows>();
  for (const row of groupRows) {
    const groupId = Number(row.group_id);
    const rows = grouped.get(groupId) ?? [];
    rows.push(row);
    grouped.set(groupId, rows);
  }

  const snapshots: GroupBalanceSnapshot[] = [];
  for (const [groupId, rows] of grouped) {
    snapshots.push({
      groupId,
      balances: rows.map((row) => [Number(row.user_id), Number(row.net_cents)]),
    });
    const plan = simplifyDebts(new Map(rows.map((row) => [Number(row.user_id), Number(row.net_cents)])));
    for (const transfer of plan) {
      if (transfer.from !== userId && transfer.to !== userId) continue;
      const friendId = transfer.from === userId ? transfer.to : transfer.from;
      if (friendFilter !== null && friendId !== friendFilter) continue;
      const obligations = byFriend.get(friendId) ?? [];
      obligations.push({
        groupId,
        groupName: String(rows[0].group_name),
        currency: String(rows[0].currency),
        netCents: transfer.to === userId ? transfer.amountCents : -transfer.amountCents,
      });
      byFriend.set(friendId, obligations);
    }

    const memberIds = rows.map((row) => Number(row.user_id));
    const reconcile = Boolean(rows[0].auto_reconcile_units);
    for (const unit of parseUnitLedger(rows[0].unit_ledger)) {
      const result = computeUnitBalances(memberIds, unit.expenses, unit.settlements, reconcile);
      const unitTransfers = reconcile
        ? result.transfers
        : result.obligations.map((row) => ({ from: row.from, to: row.to, amountCents: row.amountCents }));
      for (const transfer of unitTransfers) {
        if (transfer.from !== userId && transfer.to !== userId) continue;
        const friendId = transfer.from === userId ? transfer.to : transfer.from;
        if (friendFilter !== null && friendId !== friendFilter) continue;
        const obligations = byFriend.get(friendId) ?? [];
        obligations.push({
          groupId,
          groupName: String(rows[0].group_name),
          currency: String(rows[0].currency),
          netCents: transfer.to === userId ? transfer.amountCents : -transfer.amountCents,
          kind: "unit",
          unitId: unit.unitId,
          unitName: unit.name,
        });
        byFriend.set(friendId, obligations);
      }
    }
  }
  return { byFriend, snapshots };
}

export async function friendObligations(userId: number, onlyFriendId?: number): Promise<Map<number, FriendObligation[]>> {
  const friendFilter = onlyFriendId ?? null;
  const [groupRows, directRows] = await sql.transaction((tx) => [
    friendGroupRows(userId, friendFilter, tx),
    tx`
    SELECT CASE WHEN payer_id = ${userId} THEN recipient_id ELSE payer_id END AS friend_id,
      currency,
      SUM(CASE WHEN payer_id = ${userId} THEN converted_cents ELSE -converted_cents END) AS net_cents
    FROM settlements
    WHERE group_id IS NULL
      AND (payer_id = ${userId} OR recipient_id = ${userId})
      AND (${friendFilter}::bigint IS NULL OR payer_id = ${friendFilter} OR recipient_id = ${friendFilter})
    GROUP BY friend_id, currency`,
  ], { readOnly: true });
  const byFriend = groupObligationsSnapshot(groupRows, userId, friendFilter).byFriend;

  for (const row of directRows) {
    const friendId = Number(row.friend_id);
    const netCents = Number(row.net_cents);
    if (netCents === 0) continue;
    const obligations = byFriend.get(friendId) ?? [];
    obligations.push({ groupId: null, groupName: null, currency: String(row.currency), netCents });
    byFriend.set(friendId, obligations);
  }

  for (const obligations of byFriend.values()) {
    obligations.sort((a, b) =>
      (a.groupName ?? "").localeCompare(b.groupName ?? "") ||
      (a.kind ?? "money").localeCompare(b.kind ?? "money") ||
      (a.unitName ?? "").localeCompare(b.unitName ?? "") ||
      a.currency.localeCompare(b.currency) ||
      a.netCents - b.netCents
    );
  }
  return byFriend;
}

export async function friendBalances(userId: number): Promise<FriendBalance[]> {
  const obligationsByFriend = await friendObligations(userId);
  const friendIds = [...obligationsByFriend.keys()];
  if (friendIds.length === 0) return [];
  const users = await sql`SELECT id, display_name, username FROM users WHERE id = ANY(${friendIds})`;
  return users.map((u) => {
    const obligations = obligationsByFriend.get(Number(u.id)) ?? [];
    return {
      friendId: Number(u.id),
      displayName: u.display_name,
      username: u.username,
      obligations,
      netByCurrency: netObligations(obligations),
    };
  });
}

export async function pairwiseFriendObligations(userId: number, friendId: number): Promise<FriendObligation[]> {
  return (await friendObligations(userId, friendId)).get(friendId) ?? [];
}

export async function isGroupMember(groupId: number, userId: number): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM group_members WHERE group_id = ${groupId} AND user_id = ${userId}`;
  return rows.length > 0;
}

export async function loadGroupMemberIds(groupId: number): Promise<Set<number>> {
  const rows = await sql`SELECT user_id FROM group_members WHERE group_id = ${groupId}`;
  return new Set(rows.map((r) => Number(r.user_id)));
}
