import { sql } from "./db";
import { forbidden, notFound } from "./api";
import { newInviteCode, SessionUser } from "./auth";

export interface AuthorizedGroup {
  id: number;
  name: string;
  currency: string;
  inviteCode: string;
  createdBy: number;
}

export function parseGroupId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id)) notFound();
  return id;
}

export async function requireGroupMember(groupId: number, userId: number): Promise<AuthorizedGroup> {
  const rows = await sql`
    SELECT g.id, g.name, g.currency, g.invite_code, g.created_by,
      EXISTS (
        SELECT 1 FROM group_members gm
        WHERE gm.group_id = g.id AND gm.user_id = ${userId}
      ) AS is_member
    FROM groups g
    WHERE g.id = ${groupId}`;
  if (rows.length === 0) notFound();
  if (!rows[0].is_member) forbidden("You are not a member of this group");
  return {
    id: Number(rows[0].id),
    name: rows[0].name,
    currency: rows[0].currency,
    inviteCode: rows[0].invite_code,
    createdBy: Number(rows[0].created_by),
  };
}

export async function createGroup(user: SessionUser, name: string, currency: string) {
  const inviteCode = newInviteCode();
  const summary = `${user.displayName} created the group "${name}"`;
  const actionText = `created the group "${name}"`;
  const rows = await sql`
    WITH g AS (
      INSERT INTO groups (name, currency, invite_code, created_by)
      VALUES (${name}, ${currency}, ${inviteCode}, ${user.id})
      RETURNING id, invite_code
    ),
    m AS (
      INSERT INTO group_members (group_id, user_id)
      SELECT id, ${user.id} FROM g
      RETURNING 1
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT id, ${user.id}, 'group.created', ${summary}, ${JSON.stringify({ actionText })}::jsonb
      FROM g
      RETURNING 1
    )
    SELECT id, invite_code FROM g`;
  return { id: Number(rows[0].id), inviteCode: rows[0].invite_code as string };
}

export async function renameGroupWithActivity(groupId: number, user: SessionUser, name: string) {
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH prev AS (
      SELECT name FROM groups WHERE id = ${groupId}
    ),
    upd AS (
      UPDATE groups SET name = ${name}
      WHERE id = ${groupId}
        AND EXISTS (
          SELECT 1 FROM group_members
          WHERE group_id = ${groupId} AND user_id = ${user.id}
        )
      RETURNING id
    ),
    t AS (
      SELECT 'renamed the group from "' || prev.name || '" to "' || ${name} || '"' AS action
      FROM prev
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${groupId}, ${user.id}, 'group.renamed',
        ${user.displayName} || ' ' || t.action,
        jsonb_build_object('actionText', t.action)
      FROM upd, t
      RETURNING 1
    )
    SELECT id FROM upd`,
  ]);
  if (rows.length === 0) notFound();
}

export async function deleteGroup(
  groupId: number,
  user: SessionUser
): Promise<{ deleted: boolean; outstandingBalances: number; activeRecurring: number }> {
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH can_delete AS (
      SELECT g.id
      FROM groups g
      WHERE g.id = ${groupId}
        AND g.created_by = ${user.id}
        AND NOT EXISTS (
          SELECT 1 FROM group_balance_rows(${groupId}) WHERE net_cents <> 0
        )
        AND NOT EXISTS (
          SELECT 1 FROM recurring_expenses
          WHERE group_id = ${groupId} AND active
        )
    ),
    del AS (
      DELETE FROM groups
      WHERE id IN (SELECT id FROM can_delete)
      RETURNING id
    )
    SELECT
      EXISTS(SELECT 1 FROM del) AS deleted,
      (SELECT COUNT(*)::int FROM group_balance_rows(${groupId}) WHERE net_cents <> 0) AS outstanding_balances,
      (SELECT COUNT(*)::int FROM recurring_expenses WHERE group_id = ${groupId} AND active) AS active_recurring`,
  ]);
  return {
    deleted: Boolean(rows[0]?.deleted),
    outstandingBalances: Number(rows[0]?.outstanding_balances ?? 0),
    activeRecurring: Number(rows[0]?.active_recurring ?? 0),
  };
}

export async function removeGroupMemberWithActivity({
  groupId,
  targetId,
  actor,
  removingSelf,
}: {
  groupId: number;
  targetId: number;
  actor: SessionUser;
  removingSelf: boolean;
}) {
  const selfText = removingSelf ? "left the group" : null;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH member_balance AS (
      SELECT COALESCE((
        SELECT net_cents FROM group_balance_rows(${groupId}) WHERE user_id = ${targetId}
      ), 0)::bigint AS net_cents
    ),
    active_recurring_refs AS (
      SELECT count(*)::int AS ref_count
      FROM recurring_expenses
      WHERE group_id = ${groupId}
        AND active
        AND (payer_id = ${targetId} OR ${targetId} = ANY(participant_ids))
    ),
    del AS (
      DELETE FROM group_members
      USING member_balance, active_recurring_refs
      WHERE group_id = ${groupId}
        AND user_id = ${targetId}
        AND member_balance.net_cents = 0
        AND active_recurring_refs.ref_count = 0
      RETURNING user_id
    ),
    t AS (
      SELECT COALESCE(${selfText}::text, 'removed ' || u.display_name || ' from the group') AS action
      FROM users u
      WHERE u.id = ${targetId}
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${groupId}, ${actor.id}, 'group.member_removed',
        ${actor.displayName} || ' ' || t.action,
        jsonb_build_object('actionText', t.action, 'removedUserId', ${targetId}::bigint)
      FROM del, t
      RETURNING 1
    )
    SELECT
      (SELECT net_cents FROM member_balance) AS net_cents,
      (SELECT ref_count FROM active_recurring_refs) AS active_recurring_refs,
      (SELECT count(*) FROM del)::int AS removed`,
  ]);
  return {
    removed: Number(rows[0]?.removed ?? 0) > 0,
    netCents: Number(rows[0]?.net_cents ?? 0),
    activeRecurringRefs: Number(rows[0]?.active_recurring_refs ?? 0),
  };
}
