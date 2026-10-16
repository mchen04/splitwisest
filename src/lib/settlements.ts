import { z } from "zod";
import { sql } from "./db";
import { fmtMoney } from "./money";
import { CURRENCIES } from "./fx";
import { badRequest, forbidden, notFound } from "./api";
import { isGroupMember } from "./balances";
import { convert } from "./fx";
import { activityData } from "./activity";
import { Change, feedLine } from "./activity-diff";
import { VersionToken, versionToken } from "./versions";
import { validateCurrencyAmount } from "./currencies";

// Validation fields shared by group and direct (friend) settlement bodies.
export const settlementFields = {
  amountCents: z.number().int().positive("Amount must be positive").max(100_000_000_000),
  currency: z.string().refine((c) => CURRENCIES.includes(c), "Unsupported currency"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  note: z.string().max(500).default(""),
};

export const settlementVersionField = {
  expectedUpdatedAt: VersionToken,
};

// The activity summary line shared by both settlement routes.
export async function settlementSummary(
  payerId: number,
  recipientId: number,
  amountCents: number,
  currency: string
): Promise<string> {
  const names = await sql`SELECT id, display_name FROM users WHERE id IN (${payerId}, ${recipientId})`;
  const nameOf = (id: number) => names.find((n) => Number(n.id) === id)?.display_name ?? "Someone";
  return `${nameOf(payerId)} paid ${nameOf(recipientId)} ${fmtMoney(amountCents, currency)} (recorded offline)`;
}

export async function recordGroupSettlement(
  groupId: number,
  groupCurrency: string,
  createdBy: number,
  body: {
    payerId: number;
    recipientId: number;
    amountCents: number;
    currency: string;
    date: string;
    note: string;
  },
  expectedBalances?: [number, number][]
): Promise<{ id: number; updatedAt: string }> {
  // The recorder must be a party to the payment. Without this, any group member
  // could fabricate/alter a settlement between two OTHER members and silently
  // shift their money-bearing balance (mirrors the guard in recordDirectSettlement).
  if (createdBy !== body.payerId && createdBy !== body.recipientId) forbidden("You can't record this settlement");
  validateCurrencyAmount(body.amountCents, body.currency);
  const { cents: convertedCents } = await convert(body.amountCents, body.currency, groupCurrency);
  const summary = await settlementSummary(body.payerId, body.recipientId, body.amountCents, body.currency);
  const expectedSnapshot = expectedBalances ? JSON.stringify(expectedBalances) : null;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH balance_unchanged AS (
      SELECT ${expectedSnapshot}::jsonb IS NULL OR ${expectedSnapshot}::jsonb = COALESCE(
        (SELECT jsonb_agg(jsonb_build_array(rows.user_id, rows.net_cents) ORDER BY rows.user_id)
         FROM group_balance_rows(${groupId}) rows),
        '[]'::jsonb
      ) AS ok
    ),
    members_ok AS (
      SELECT 1
      WHERE (SELECT ok FROM balance_unchanged)
      AND EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${groupId} AND user_id = ${body.payerId}
      )
      AND EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${groupId} AND user_id = ${body.recipientId}
      )
      AND EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${groupId} AND user_id = ${createdBy}
      )
    ),
    s AS (
      INSERT INTO settlements (group_id, payer_id, recipient_id, amount_cents, currency, converted_cents, settled_date, note, created_by)
      SELECT ${groupId}, ${body.payerId}, ${body.recipientId}, ${body.amountCents}, ${body.currency},
        ${convertedCents}, ${body.date}, ${body.note}, ${createdBy}
      FROM members_ok
      RETURNING id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${groupId}, ${createdBy}, 'settlement.recorded', ${summary},
        jsonb_build_object('settlementId', s.id, 'actionText', ${summary}::text)
      FROM s
      RETURNING 1
    )
    SELECT id, updated_at FROM s`,
  ]);
  if (!rows[0]) {
    badRequest(expectedBalances ? "This balance changed. Refresh and try again" : "Both people must be group members");
  }
  return { id: Number(rows[0].id), updatedAt: versionToken(rows[0].updated_at) };
}

export async function recordDirectSettlement(
  createdBy: number,
  body: {
    payerId: number;
    recipientId: number;
    amountCents: number;
    currency: string;
    date: string;
    note: string;
  },
  settleFullBalance = false
): Promise<{ id: number; updatedAt: string }> {
  if (createdBy !== body.payerId && createdBy !== body.recipientId) forbidden("You can't record this settlement");
  validateCurrencyAmount(body.amountCents, body.currency);
  const userA = Math.min(body.payerId, body.recipientId);
  const userB = Math.max(body.payerId, body.recipientId);
  const summary = await settlementSummary(body.payerId, body.recipientId, body.amountCents, body.currency);
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${userA}::int, ${userB}::int)`,
    tx`
    WITH balance_ok AS (
      SELECT ${settleFullBalance}::boolean = false OR EXISTS (
        SELECT 1
        FROM settlements
        WHERE group_id IS NULL
          AND ((payer_id = ${body.payerId} AND recipient_id = ${body.recipientId})
            OR (payer_id = ${body.recipientId} AND recipient_id = ${body.payerId}))
          AND currency = ${body.currency}
        GROUP BY currency
        HAVING SUM(
          CASE WHEN payer_id = ${createdBy} THEN converted_cents ELSE -converted_cents END
        ) = ${createdBy === body.payerId ? -body.amountCents : body.amountCents}
      ) AS ok
    ),
    friendship_ok AS (
      SELECT 1
      FROM friendships
      WHERE user_a = ${userA} AND user_b = ${userB}
        AND (SELECT ok FROM balance_ok)
    ),
    s AS (
      INSERT INTO settlements (group_id, payer_id, recipient_id, amount_cents, currency, converted_cents, settled_date, note, created_by)
      SELECT NULL, ${body.payerId}, ${body.recipientId}, ${body.amountCents}, ${body.currency},
        ${body.amountCents}, ${body.date}, ${body.note}, ${createdBy}
      FROM friendship_ok
      RETURNING id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT null, ${createdBy}, 'settlement.recorded', ${summary},
        jsonb_build_object(
          'visibleUserIds', to_jsonb(ARRAY[${String(body.payerId)}::text, ${String(body.recipientId)}::text]),
          'settlementId', s.id,
          'actionText', ${summary}::text
        )
      FROM s
      RETURNING 1
    )
    SELECT id, updated_at FROM s`,
  ]);
  if (!rows[0]) {
    if (settleFullBalance) badRequest("This balance changed. Refresh and try again");
    forbidden("You are not friends with this user");
  }
  return { id: Number(rows[0].id), updatedAt: versionToken(rows[0].updated_at) };
}

/** A recorded payment can move in four ways a person would notice. */
function diffSettlement(
  prev: { amountCents: number; currency: string; date: string; note: string },
  next: { amountCents: number; currency: string; date: string; note: string }
): Change[] {
  const changes: Change[] = [];
  if (prev.amountCents !== next.amountCents) {
    changes.push({
      field: "amount",
      fromCents: prev.amountCents,
      toCents: next.amountCents,
      fromCurrency: prev.currency,
      toCurrency: next.currency,
    });
  }
  if (prev.currency !== next.currency) changes.push({ field: "currency", from: prev.currency, to: next.currency });
  if (prev.date !== next.date) changes.push({ field: "date", from: prev.date, to: next.date });
  if (prev.note !== next.note) {
    changes.push({ field: "notes", kind: !prev.note ? "added" : !next.note ? "removed" : "changed" });
  }
  return changes;
}

export async function updateSettlementWithActivity(
  settlement: AuthorizedSettlement,
  user: { id: number; displayName: string },
  body: { amountCents: number; currency: string; date: string; note: string; expectedUpdatedAt: string },
  convertedCents: number
) {
  validateCurrencyAmount(body.amountCents, body.currency);
  const fallbackText = await settlementSummary(settlement.payerId, settlement.recipientId, body.amountCents, body.currency);
  const changes = diffSettlement(settlement, body);
  const actionText = feedLine(changes) ?? `edited a recorded payment - now ${fallbackText}`;
  const summary = `${user.displayName} ${actionText}`;
  const visibleUserIds = [settlement.payerId, settlement.recipientId].map(String);
  const userA = Math.min(settlement.payerId, settlement.recipientId);
  const userB = Math.max(settlement.payerId, settlement.recipientId);
  const [, rows] = await sql.transaction((tx) => [
    settlement.groupId === null
      ? tx`SELECT pg_advisory_xact_lock(${userA}::int, ${userB}::int)`
      : tx`SELECT pg_advisory_xact_lock(${settlement.groupId}::int)`,
    tx`
    WITH existing_members_ok AS (
      SELECT 1
      WHERE (
          ${settlement.groupId}::bigint IS NULL
          AND EXISTS (
            SELECT 1 FROM friendships
            WHERE user_a = ${userA} AND user_b = ${userB}
          )
        )
        OR (
          EXISTS (
            SELECT 1 FROM group_members
            WHERE group_id = ${settlement.groupId} AND user_id = ${settlement.payerId}
          )
          AND EXISTS (
            SELECT 1 FROM group_members
            WHERE group_id = ${settlement.groupId} AND user_id = ${settlement.recipientId}
          )
          AND EXISTS (
            SELECT 1 FROM group_members
            WHERE group_id = ${settlement.groupId} AND user_id = ${user.id}
          )
        )
    ),
    upd AS (
      UPDATE settlements SET amount_cents = ${body.amountCents}, currency = ${body.currency},
        converted_cents = ${convertedCents}, settled_date = ${body.date}, note = ${body.note}, updated_at = now()
      FROM existing_members_ok
      WHERE id = ${settlement.id}
        AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = ${body.expectedUpdatedAt}
      RETURNING id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${settlement.groupId}, ${user.id}, 'settlement.updated', ${summary},
        ${activityData({
          ...(settlement.groupId === null ? { visibleUserIds } : {}),
          ...(changes.length ? { changes } : {}),
        }, actionText)}::jsonb
      FROM upd
      RETURNING 1
    ),
    stale AS (
      SELECT 1 FROM settlements
      WHERE id = ${settlement.id}
        AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') <> ${body.expectedUpdatedAt}
    )
    SELECT (SELECT count(*) FROM upd)::int AS updated,
      EXISTS(SELECT 1 FROM stale) AS stale,
      (SELECT updated_at FROM upd) AS updated_at`,
  ]);
  if (Number(rows[0]?.updated ?? 0) === 0 && rows[0]?.stale) badRequest("Settlement changed, refresh and try again");
  if (Number(rows[0]?.updated ?? 0) === 0 && settlement.groupId === null) forbidden("You are not friends with this user");
  if (Number(rows[0]?.updated ?? 0) === 0) badRequest("This settlement involves someone who has left the group");
  return { updatedAt: versionToken(rows[0].updated_at) };
}

export async function deleteSettlementWithActivity(
  settlement: AuthorizedSettlement,
  user: { id: number; displayName: string },
  expectedUpdatedAt: string
) {
  const summary = `${user.displayName} deleted a recorded payment`;
  const visibleUserIds = [settlement.payerId, settlement.recipientId].map(String);
  const userA = Math.min(settlement.payerId, settlement.recipientId);
  const userB = Math.max(settlement.payerId, settlement.recipientId);
  const [, rows] = await sql.transaction((tx) => [
    settlement.groupId === null
      ? tx`SELECT pg_advisory_xact_lock(${userA}::int, ${userB}::int)`
      : tx`SELECT pg_advisory_xact_lock(${settlement.groupId}::int)`,
    tx`
    WITH existing_members_ok AS (
      SELECT 1
      WHERE (
          ${settlement.groupId}::bigint IS NULL
          AND EXISTS (
            SELECT 1 FROM friendships
            WHERE user_a = ${userA} AND user_b = ${userB}
          )
        )
        OR (
          EXISTS (
            SELECT 1 FROM group_members
            WHERE group_id = ${settlement.groupId} AND user_id = ${settlement.payerId}
          )
          AND EXISTS (
            SELECT 1 FROM group_members
            WHERE group_id = ${settlement.groupId} AND user_id = ${settlement.recipientId}
          )
          AND EXISTS (
            SELECT 1 FROM group_members
            WHERE group_id = ${settlement.groupId} AND user_id = ${user.id}
          )
        )
    ),
    del AS (
      DELETE FROM settlements
      USING existing_members_ok
      WHERE id = ${settlement.id}
        AND to_char(settlements.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = ${expectedUpdatedAt}
      RETURNING id
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${settlement.groupId}, ${user.id}, 'settlement.deleted', ${summary},
        ${activityData(settlement.groupId === null ? { visibleUserIds } : {})}::jsonb
      FROM del
      RETURNING 1
    ),
    stale AS (
      SELECT 1 FROM settlements
      WHERE id = ${settlement.id}
        AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') <> ${expectedUpdatedAt}
    )
    SELECT (SELECT count(*) FROM del)::int AS deleted,
      EXISTS(SELECT 1 FROM stale) AS stale`,
  ]);
  if (Number(rows[0]?.deleted ?? 0) === 0 && rows[0]?.stale) badRequest("Settlement changed, refresh and try again");
  if (Number(rows[0]?.deleted ?? 0) === 0 && settlement.groupId === null) forbidden("You are not friends with this user");
  if (Number(rows[0]?.deleted ?? 0) === 0) badRequest("This settlement involves someone who has left the group");
}

export interface AuthorizedSettlement {
  id: number;
  groupId: number | null;
  payerId: number;
  recipientId: number;
  createdBy: number;
  amountCents: number;
  currency: string;
  convertedCents: number;
  date: string;
  note: string;
  updatedAt: string;
}

export interface SettlementHistoryRow {
  id: number;
  groupId: number | null;
  groupName: string | null;
  payerId: number;
  payerName: string;
  recipientId: number;
  recipientName: string;
  amountCents: number;
  currency: string;
  date: string;
  note: string;
}

function mapSettlementHistory(rows: Record<string, unknown>[]): SettlementHistoryRow[] {
  return rows.map((s) => ({
    id: Number(s.id),
    groupId: s.group_id ? Number(s.group_id) : null,
    groupName: s.group_name as string | null,
    payerId: Number(s.payer_id),
    payerName: s.payer_name as string,
    recipientId: Number(s.recipient_id),
    recipientName: s.recipient_name as string,
    amountCents: Number(s.amount_cents),
    currency: s.currency as string,
    date: s.settled_date as string,
    note: s.note as string,
  }));
}

export async function loadVisibleSettlementHistory({
  viewerId,
  personId,
  isSelf,
  isFriend,
  groupIds,
}: {
  viewerId: number;
  personId: number;
  isSelf: boolean;
  isFriend: boolean;
  groupIds: number[];
}): Promise<SettlementHistoryRow[]> {
  if (isSelf) {
    const rows = await sql`
      SELECT s.id, s.group_id, g.name AS group_name, s.payer_id, p.display_name AS payer_name,
        s.recipient_id, r.display_name AS recipient_name, s.amount_cents, s.currency,
        s.settled_date, s.note
      FROM settlements s
      LEFT JOIN groups g ON g.id = s.group_id
      JOIN users p ON p.id = s.payer_id
      JOIN users r ON r.id = s.recipient_id
      WHERE s.payer_id = ${viewerId} OR s.recipient_id = ${viewerId}
      ORDER BY s.settled_date DESC, s.id DESC
      LIMIT 20`;
    return mapSettlementHistory(rows);
  }
  if (isFriend) {
    const rows = await sql`
      SELECT s.id, s.group_id, g.name AS group_name, s.payer_id, p.display_name AS payer_name,
        s.recipient_id, r.display_name AS recipient_name, s.amount_cents, s.currency,
        s.settled_date, s.note
      FROM settlements s
      LEFT JOIN groups g ON g.id = s.group_id
      JOIN users p ON p.id = s.payer_id
      JOIN users r ON r.id = s.recipient_id
      WHERE ((s.payer_id = ${viewerId} AND s.recipient_id = ${personId})
         OR (s.payer_id = ${personId} AND s.recipient_id = ${viewerId}))
        AND (s.group_id IS NULL OR (${groupIds.length} > 0 AND s.group_id = ANY(${groupIds})))
      ORDER BY s.settled_date DESC, s.id DESC
      LIMIT 20`;
    return mapSettlementHistory(rows);
  }
  if (groupIds.length === 0) return [];
  const rows = await sql`
    SELECT s.id, s.group_id, g.name AS group_name, s.payer_id, p.display_name AS payer_name,
      s.recipient_id, r.display_name AS recipient_name, s.amount_cents, s.currency,
      s.settled_date, s.note
    FROM settlements s
    JOIN groups g ON g.id = s.group_id
    JOIN users p ON p.id = s.payer_id
    JOIN users r ON r.id = s.recipient_id
    WHERE ((s.payer_id = ${viewerId} AND s.recipient_id = ${personId})
       OR (s.payer_id = ${personId} AND s.recipient_id = ${viewerId}))
      AND s.group_id = ANY(${groupIds})
    ORDER BY s.settled_date DESC, s.id DESC
    LIMIT 20`;
  return mapSettlementHistory(rows);
}

export async function loadAuthorizedSettlementForMutation(id: number, userId: number): Promise<AuthorizedSettlement> {
  if (!Number.isInteger(id)) notFound();
  const rows = await sql`
    SELECT id, group_id, payer_id, recipient_id, created_by, amount_cents, currency, converted_cents,
      to_char(settled_date, 'YYYY-MM-DD') AS settled_date, note,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    FROM settlements
    WHERE id = ${id}`;
  if (rows.length === 0) notFound();
  const raw = rows[0];
  const groupId = raw.group_id === null ? null : Number(raw.group_id);
  const settlement = {
    id: Number(raw.id),
    groupId,
    payerId: Number(raw.payer_id),
    recipientId: Number(raw.recipient_id),
    createdBy: Number(raw.created_by),
    amountCents: Number(raw.amount_cents),
    currency: raw.currency as string,
    convertedCents: Number(raw.converted_cents),
    date: raw.settled_date as string,
    note: (raw.note as string | null) ?? "",
    updatedAt: versionToken(raw.updated_at),
  };
  const isParticipant = settlement.payerId === userId || settlement.recipientId === userId;
  const allowed = groupId === null
    ? isParticipant
    : (settlement.createdBy === userId || isParticipant) && await isGroupMember(groupId, userId);
  if (!allowed) forbidden("You can't edit this settlement");
  return settlement;
}
