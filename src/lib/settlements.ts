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
import { requireGroupUnit } from "./group-units";
import { formatDenomination, validateUnitRepayment } from "./units";

// Validation fields shared by group and direct (friend) settlement bodies.
export const settlementFields = {
  amountCents: z.number().int().positive("Amount must be positive").max(100_000_000_000),
  currency: z.string().refine((c) => CURRENCIES.includes(c), "Unsupported currency"),
  unitId: z.number().int().positive().nullable().optional(),
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
  currency: string,
  unitName?: string | null
): Promise<string> {
  const names = await sql`SELECT id, display_name FROM users WHERE id IN (${payerId}, ${recipientId})`;
  const nameOf = (id: number) => names.find((n) => Number(n.id) === id)?.display_name ?? "Someone";
  const amountText = unitName
    ? formatDenomination(amountCents, { kind: "unit", unitId: 0, name: unitName })
    : fmtMoney(amountCents, currency);
  return `${nameOf(payerId)} paid ${nameOf(recipientId)} ${amountText} (recorded offline)`;
}

async function groupCurrencyForSettlement(groupId: number, settlement: AuthorizedSettlement) {
  const rows = await sql`SELECT currency FROM groups WHERE id = ${groupId}`;
  return (rows[0]?.currency as string | undefined) ?? settlement.currency;
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
    unitId?: number | null;
    date: string;
    note: string;
  },
  expectedBalances?: [number, number][]
): Promise<{ id: number; updatedAt: string }> {
  // The recorder must be a party to the payment. Without this, any group member
  // could fabricate/alter a settlement between two OTHER members and silently
  // shift their money-bearing balance (mirrors the guard in recordDirectSettlement).
  if (createdBy !== body.payerId && createdBy !== body.recipientId) forbidden("You can't record this settlement");
  const unit = body.unitId != null ? await requireGroupUnit(groupId, body.unitId) : null;
  if (!unit) validateCurrencyAmount(body.amountCents, body.currency);
  const currency = unit ? groupCurrency : body.currency;
  const convertedCents = unit ? body.amountCents : (await convert(body.amountCents, body.currency, groupCurrency)).cents;
  const summary = await settlementSummary(body.payerId, body.recipientId, body.amountCents, currency, unit?.name);
  const expectedSnapshot = expectedBalances ? JSON.stringify(expectedBalances) : null;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH lock AS (
      SELECT pg_advisory_xact_lock(${groupId}::int)
    ),
    unit_gate AS (
      SELECT 1 FROM lock
      WHERE ${body.unitId ?? null}::bigint IS NULL
        OR EXISTS (SELECT 1 FROM groups WHERE id = ${groupId} AND auto_reconcile_units)
        OR unit_directed_obligation(${groupId}, ${body.unitId}, ${body.payerId}, ${body.recipientId}) >= ${body.amountCents}
    ),
    balance_unchanged AS (
      SELECT ${expectedSnapshot}::jsonb IS NULL OR ${expectedSnapshot}::jsonb = COALESCE(
        (SELECT jsonb_agg(jsonb_build_array(rows.user_id, rows.net_cents) ORDER BY rows.user_id)
         FROM group_balance_rows(${groupId}) rows),
        '[]'::jsonb
      ) AS ok
    ),
    members_ok AS (
      SELECT 1
      WHERE (SELECT ok FROM balance_unchanged)
      AND EXISTS (SELECT 1 FROM unit_gate)
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
      INSERT INTO settlements (group_id, payer_id, recipient_id, amount_cents, currency, converted_cents, unit_id, settled_date, note, created_by)
      SELECT ${groupId}, ${body.payerId}, ${body.recipientId}, ${body.amountCents}, ${currency},
        ${convertedCents}, ${body.unitId ?? null}, ${body.date}, ${body.note}, ${createdBy}
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
    if (unit && body.unitId != null) {
      const auto = await sql`SELECT auto_reconcile_units FROM groups WHERE id = ${groupId}`;
      if (!auto[0]?.auto_reconcile_units) {
        const outstanding = Number((await sql`
          SELECT unit_directed_obligation(${groupId}, ${body.unitId}, ${body.payerId}, ${body.recipientId}) AS cents`
        )[0]?.cents ?? 0);
        const message = validateUnitRepayment({
          reconcile: false,
          obligations: [{ from: body.payerId, to: body.recipientId, amountCents: outstanding }],
          payerId: body.payerId,
          recipientId: body.recipientId,
          amountCents: body.amountCents,
        });
        if (message) badRequest(message.replace("this unit", unit.name));
      }
    }
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
    unitId?: number | null;
    date: string;
    note: string;
  },
  settleFullBalance = false
): Promise<{ id: number; updatedAt: string }> {
  if (createdBy !== body.payerId && createdBy !== body.recipientId) forbidden("You can't record this settlement");
  if (body.unitId != null) badRequest("Direct payments stay in money");
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
  prev: { amountCents: number; currency: string; unitName?: string | null; date: string; note: string },
  next: { amountCents: number; currency: string; unitName?: string | null; date: string; note: string }
): Change[] {
  const changes: Change[] = [];
  const prevUnit = prev.unitName ?? null;
  const nextUnit = next.unitName ?? null;
  if (prev.amountCents !== next.amountCents || prevUnit !== nextUnit) {
    changes.push({
      field: "amount",
      fromCents: prev.amountCents,
      toCents: next.amountCents,
      fromCurrency: prev.currency,
      toCurrency: next.currency,
      fromUnitName: prevUnit,
      toUnitName: nextUnit,
    });
  }
  if (prev.currency !== next.currency && prevUnit === nextUnit) {
    changes.push({ field: "currency", from: prev.currency, to: next.currency });
  }
  if (prev.date !== next.date) changes.push({ field: "date", from: prev.date, to: next.date });
  if (prev.note !== next.note) {
    changes.push({ field: "notes", kind: !prev.note ? "added" : !next.note ? "removed" : "changed" });
  }
  return changes;
}

export async function updateSettlementWithActivity(
  settlement: AuthorizedSettlement,
  user: { id: number; displayName: string },
  body: { amountCents: number; currency: string; unitId?: number | null; date: string; note: string; expectedUpdatedAt: string },
  convertedCents: number
) {
  const unitId = body.unitId === undefined ? settlement.unitId : body.unitId;
  if (settlement.groupId === null && unitId != null) badRequest("Direct payments stay in money");
  const unit = unitId != null && settlement.groupId !== null
    ? await requireGroupUnit(settlement.groupId, unitId)
    : null;
  if (!unit) validateCurrencyAmount(body.amountCents, body.currency);
  const currency = unit ? await groupCurrencyForSettlement(settlement.groupId!, settlement) : body.currency;
  const effectiveConverted = unit ? body.amountCents : convertedCents;
  const fallbackText = await settlementSummary(
    settlement.payerId, settlement.recipientId, body.amountCents, currency, unit?.name
  );
  const changes = diffSettlement(settlement, { ...body, currency, unitName: unit?.name ?? null });
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
    WITH unit_gate AS (
      SELECT 1
      WHERE ${unitId}::bigint IS NULL
        OR ${settlement.groupId}::bigint IS NULL
        OR EXISTS (SELECT 1 FROM groups WHERE id = ${settlement.groupId} AND auto_reconcile_units)
        OR unit_directed_obligation(${settlement.groupId}, ${unitId}, ${settlement.payerId}, ${settlement.recipientId}, ${settlement.id}) >= ${body.amountCents}
    ),
    existing_members_ok AS (
      SELECT 1
      WHERE EXISTS (SELECT 1 FROM unit_gate)
        AND (
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
      UPDATE settlements SET amount_cents = ${body.amountCents}, currency = ${currency},
        converted_cents = ${effectiveConverted}, unit_id = ${unitId},
        settled_date = ${body.date}, note = ${body.note}, updated_at = now()
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
  if (Number(rows[0]?.updated ?? 0) === 0 && unit && settlement.groupId !== null) {
    const auto = await sql`SELECT auto_reconcile_units FROM groups WHERE id = ${settlement.groupId}`;
    if (!auto[0]?.auto_reconcile_units) {
      const outstanding = Number((await sql`
        SELECT unit_directed_obligation(${settlement.groupId}, ${unit.id}, ${settlement.payerId}, ${settlement.recipientId}, ${settlement.id}) AS cents`
      )[0]?.cents ?? 0);
      const message = validateUnitRepayment({
        reconcile: false,
        obligations: [{ from: settlement.payerId, to: settlement.recipientId, amountCents: outstanding }],
        payerId: settlement.payerId,
        recipientId: settlement.recipientId,
        amountCents: body.amountCents,
      });
      if (message) badRequest(message.replace("this unit", unit.name));
    }
  }
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
  unitId: number | null;
  unitName: string | null;
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
  unitId: number | null;
  unitName: string | null;
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
    unitId: s.unit_id === null || s.unit_id === undefined ? null : Number(s.unit_id),
    unitName: (s.unit_name as string | null) ?? null,
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
        s.unit_id, gu.name AS unit_name,
        s.settled_date, s.note
      FROM settlements s
      LEFT JOIN groups g ON g.id = s.group_id
      LEFT JOIN group_units gu ON gu.id = s.unit_id
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
        s.unit_id, gu.name AS unit_name,
        s.settled_date, s.note
      FROM settlements s
      LEFT JOIN groups g ON g.id = s.group_id
      LEFT JOIN group_units gu ON gu.id = s.unit_id
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
      s.unit_id, gu.name AS unit_name,
      s.settled_date, s.note
    FROM settlements s
    JOIN groups g ON g.id = s.group_id
    LEFT JOIN group_units gu ON gu.id = s.unit_id
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
    SELECT s.id, s.group_id, s.payer_id, s.recipient_id, s.created_by, s.amount_cents, s.currency,
      s.converted_cents, s.unit_id, gu.name AS unit_name,
      to_char(settled_date, 'YYYY-MM-DD') AS settled_date, note,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    FROM settlements s
    LEFT JOIN group_units gu ON gu.id = s.unit_id
    WHERE s.id = ${id}`;
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
    unitId: raw.unit_id === null ? null : Number(raw.unit_id),
    unitName: (raw.unit_name as string | null) ?? null,
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
