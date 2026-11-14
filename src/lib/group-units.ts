import { sql } from "./db";
import { badRequest, notFound } from "./api";
import { normalizeUnitName, parseUnitLedger, unitNameError, UnitLedgerUnit } from "./units";

export interface GroupUnit {
  id: number;
  name: string;
  createdAt: string;
  expenseCount: number;
  settlementCount: number;
  recurringCount: number;
}

export async function listGroupUnits(groupId: number): Promise<GroupUnit[]> {
  const rows = await sql`
    SELECT gu.id, gu.name,
      to_char(gu.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      (SELECT count(*) FROM expenses e WHERE e.group_id = gu.group_id AND e.unit_id = gu.id) AS expense_count,
      (SELECT count(*) FROM settlements s WHERE s.group_id = gu.group_id AND s.unit_id = gu.id) AS settlement_count,
      (SELECT count(*) FROM recurring_expenses r WHERE r.group_id = gu.group_id AND r.unit_id = gu.id) AS recurring_count
    FROM group_units gu
    WHERE gu.group_id = ${groupId}
    ORDER BY gu.name, gu.id`;
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name as string,
    createdAt: row.created_at as string,
    expenseCount: Number(row.expense_count),
    settlementCount: Number(row.settlement_count),
    recurringCount: Number(row.recurring_count),
  }));
}

export async function createGroupUnit(groupId: number, userId: number, rawName: string) {
  const error = unitNameError(rawName);
  if (error) badRequest(error);
  const name = normalizeUnitName(rawName);
  const rows = await sql`
    INSERT INTO group_units (group_id, name, created_by)
    VALUES (${groupId}, ${name}, ${userId})
    ON CONFLICT (group_id, lower(btrim(name))) DO UPDATE SET name = group_units.name
    RETURNING id, name`;
  return { id: Number(rows[0].id), name: rows[0].name as string };
}

export async function renameGroupUnit(groupId: number, unitId: number, rawName: string) {
  const error = unitNameError(rawName);
  if (error) badRequest(error);
  const name = normalizeUnitName(rawName);
  try {
    const rows = await sql`
      UPDATE group_units SET name = ${name}
      WHERE id = ${unitId} AND group_id = ${groupId}
      RETURNING id, name`;
    if (rows.length === 0) notFound("Unit not found");
    return { id: Number(rows[0].id), name: rows[0].name as string };
  } catch (e) {
    if (isUniqueViolation(e)) badRequest("A unit with that name already exists");
    throw e;
  }
}

export async function deleteGroupUnit(groupId: number, unitId: number) {
  const rows = await sql`
    SELECT
      (SELECT count(*) FROM expenses WHERE group_id = ${groupId} AND unit_id = ${unitId}) AS expense_count,
      (SELECT count(*) FROM settlements WHERE group_id = ${groupId} AND unit_id = ${unitId}) AS settlement_count,
      (SELECT count(*) FROM recurring_expenses WHERE group_id = ${groupId} AND unit_id = ${unitId}) AS recurring_count`;
  const used = Number(rows[0]?.expense_count ?? 0) + Number(rows[0]?.settlement_count ?? 0) +
    Number(rows[0]?.recurring_count ?? 0);
  if (used > 0) {
    badRequest("This unit is still used by expenses, payments, or recurring expenses. Remove those first.");
  }
  try {
    const deleted = await sql`
      DELETE FROM group_units WHERE id = ${unitId} AND group_id = ${groupId} RETURNING id`;
    if (deleted.length === 0) notFound("Unit not found");
  } catch (e) {
    if (isForeignKeyViolation(e)) {
      badRequest("This unit is still used by expenses, payments, or recurring expenses. Remove those first.");
    }
    throw e;
  }
}

export async function requireGroupUnit(groupId: number, unitId: number) {
  const rows = await sql`
    SELECT id, name FROM group_units WHERE id = ${unitId} AND group_id = ${groupId}`;
  if (rows.length === 0) badRequest("Unknown unit for this group");
  return { id: Number(rows[0].id), name: rows[0].name as string };
}

export async function loadUnitLedger(groupId: number): Promise<UnitLedgerUnit[]> {
  const rows = await sql`
    SELECT gu.id AS unit_id, gu.name,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'payerId', e.payer_id,
          'amountCents', e.amount_cents,
          'shares', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('userId', es.user_id, 'shareCents', es.share_cents))
            FROM expense_shares es WHERE es.expense_id = e.id
          ), '[]'::jsonb)
        ))
        FROM expenses e WHERE e.group_id = gu.group_id AND e.unit_id = gu.id
      ), '[]'::jsonb) AS expenses,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'payerId', s.payer_id, 'recipientId', s.recipient_id, 'amountCents', s.amount_cents))
        FROM settlements s WHERE s.group_id = gu.group_id AND s.unit_id = gu.id
      ), '[]'::jsonb) AS settlements
    FROM group_units gu
    WHERE gu.group_id = ${groupId}
    ORDER BY gu.name, gu.id`;
  return parseUnitLedger(rows.map((row) => ({
    unitId: row.unit_id,
    name: row.name,
    expenses: row.expenses,
    settlements: row.settlements,
  })));
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
}

export function isForeignKeyViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23503");
}
