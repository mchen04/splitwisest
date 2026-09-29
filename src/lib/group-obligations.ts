import { sql } from "./db";
import { badRequest, notFound, forbidden } from "./api";
import { loadGroupMemberIds } from "./balances";
import { activityData } from "./activity";
import { computeGroupObligation, GroupObligationInput } from "./group-obligation-math";

function allocationsJson(input: GroupObligationInput, computed: ReturnType<typeof computeGroupObligation>) {
  return JSON.stringify((["owes", "receives"] as const).flatMap((side) => {
    const raw = new Map(input[side].participants.map((p) => [p.userId, p.value ?? null]));
    return [...computed[side]].map(([userId, cents]) => ({
      side, user_id: userId, share_cents: cents, raw_input: raw.get(userId) ?? null,
    }));
  }));
}

export async function createGroupObligation(groupId: number, currency: string, user: { id: number; displayName: string }, input: GroupObligationInput) {
  const memberIds = await loadGroupMemberIds(groupId);
  const computed = computeGroupObligation(input, memberIds, currency);
  const actionText = `added group balance "${input.title}"`;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
      WITH allocations AS (
        SELECT x.side, x.user_id, x.share_cents, x.raw_input
        FROM jsonb_to_recordset(${allocationsJson(input, computed)}::jsonb)
          AS x(side text, user_id bigint, share_cents bigint, raw_input numeric)
      ), members_ok AS (
        SELECT 1 WHERE EXISTS (
          SELECT 1 FROM group_members WHERE group_id = ${groupId} AND user_id = ${user.id}
        ) AND NOT EXISTS (
          SELECT 1 FROM allocations a WHERE NOT EXISTS (
            SELECT 1 FROM group_members gm WHERE gm.group_id = ${groupId} AND gm.user_id = a.user_id
          )
        )
      ), inserted AS (
        INSERT INTO group_obligations (group_id, title, amount_cents, owed_method, receive_method, created_by)
        SELECT ${groupId}, ${input.title}, ${input.amountCents}, ${input.owes.method}, ${input.receives.method}, ${user.id}
        FROM members_ok RETURNING id
      ), alloc AS (
        INSERT INTO group_obligation_allocations (obligation_id, side, user_id, share_cents, raw_input)
        SELECT inserted.id, a.side, a.user_id, a.share_cents, a.raw_input FROM inserted, allocations a
        RETURNING 1
      ), activity_row AS (
        INSERT INTO activity (group_id, actor_id, type, summary, data)
        SELECT ${groupId}, ${user.id}, 'group_balance.added', ${user.displayName + " " + actionText},
          jsonb_set(${activityData({}, actionText)}::jsonb, '{groupBalanceId}', to_jsonb(inserted.id))
        FROM inserted RETURNING 1
      ) SELECT id FROM inserted`,
  ]);
  if (!rows[0]) badRequest("All participants must be group members");
  return Number(rows[0].id);
}

export async function updateGroupObligation(
  id: number, groupId: number, currency: string, user: { id: number; displayName: string }, input: GroupObligationInput,
) {
  if (!input.expectedUpdatedAt) badRequest("Group balance changed, refresh and try again");
  const memberIds = await loadGroupMemberIds(groupId);
  const computed = computeGroupObligation(input, memberIds, currency);
  const actionText = `edited group balance "${input.title}"`;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
      WITH allocations AS (
        SELECT x.side, x.user_id, x.share_cents, x.raw_input
        FROM jsonb_to_recordset(${allocationsJson(input, computed)}::jsonb)
          AS x(side text, user_id bigint, share_cents bigint, raw_input numeric)
      ), members_ok AS (
        SELECT 1 WHERE EXISTS (
          SELECT 1 FROM group_members WHERE group_id = ${groupId} AND user_id = ${user.id}
        ) AND NOT EXISTS (
          SELECT 1 FROM allocations a WHERE NOT EXISTS (
            SELECT 1 FROM group_members gm WHERE gm.group_id = ${groupId} AND gm.user_id = a.user_id
          )
        )
      ), updated AS (
        UPDATE group_obligations SET title = ${input.title}, amount_cents = ${input.amountCents},
          owed_method = ${input.owes.method}, receive_method = ${input.receives.method}, updated_at = now()
        FROM members_ok WHERE id = ${id} AND group_id = ${groupId}
          AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = ${input.expectedUpdatedAt}
        RETURNING id
      ), removed AS (
        DELETE FROM group_obligation_allocations a USING updated
        WHERE a.obligation_id = updated.id RETURNING 1
      ), added AS (
        INSERT INTO group_obligation_allocations (obligation_id, side, user_id, share_cents, raw_input)
        SELECT updated.id, a.side, a.user_id, a.share_cents, a.raw_input
        FROM updated CROSS JOIN (SELECT count(*) FROM removed) old_rows CROSS JOIN allocations a RETURNING 1
      ), activity_row AS (
        INSERT INTO activity (group_id, actor_id, type, summary, data)
        SELECT ${groupId}, ${user.id}, 'group_balance.edited', ${user.displayName + " " + actionText},
          jsonb_set(${activityData({}, actionText)}::jsonb, '{groupBalanceId}', to_jsonb(updated.id))
        FROM updated RETURNING 1
      ) SELECT id FROM updated`,
  ]);
  if (!rows[0]) badRequest("Group balance changed, refresh and try again");
}

export async function deleteGroupObligation(id: number, groupId: number, user: { id: number; displayName: string }, expectedUpdatedAt: string) {
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
      WITH removed AS (
        DELETE FROM group_obligations WHERE id = ${id} AND group_id = ${groupId}
          AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = ${expectedUpdatedAt}
          AND EXISTS (SELECT 1 FROM group_members WHERE group_id = ${groupId} AND user_id = ${user.id})
        RETURNING id, title
      ), activity_row AS (
        INSERT INTO activity (group_id, actor_id, type, summary, data)
        SELECT ${groupId}, ${user.id}, 'group_balance.deleted',
          ${user.displayName} || ' deleted group balance "' || removed.title || '"',
          jsonb_build_object('actionText', 'deleted group balance "' || removed.title || '"')
        FROM removed RETURNING 1
      ) SELECT id FROM removed`,
  ]);
  if (!rows[0]) badRequest("Group balance changed, refresh and try again");
}

export async function loadGroupObligation(id: number, userId: number) {
  const rows = await sql`
    SELECT go.*, g.currency,
      to_char(go.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_token
    FROM group_obligations go JOIN groups g ON g.id = go.group_id WHERE go.id = ${id}`;
  if (!rows[0]) notFound("Group balance not found");
  const row = rows[0];
  if (!(await loadGroupMemberIds(Number(row.group_id))).has(userId)) forbidden();
  const allocations = await sql`
    SELECT side, user_id, share_cents, raw_input FROM group_obligation_allocations
    WHERE obligation_id = ${id} ORDER BY user_id`;
  const side = (name: "owes" | "receives") => ({
    method: row[name === "owes" ? "owed_method" : "receive_method"],
    participants: allocations.filter((a) => a.side === name).map((a) => ({
      userId: Number(a.user_id), shareCents: Number(a.share_cents),
      value: a.raw_input === null ? null : Number(a.raw_input),
    })),
  });
  return {
    id, groupId: Number(row.group_id), title: row.title as string, amountCents: Number(row.amount_cents),
    currency: row.currency as string, updatedAt: row.updated_at_token as string,
    owes: side("owes"), receives: side("receives"),
  };
}
