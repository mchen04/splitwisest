import { sql } from "@/lib/db";
import { forbidden, notFound } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { parseGroupId, requireGroupMember } from "@/lib/groups";
import { readSession } from "./read-session";

type Query = ReturnType<typeof sql>;

export async function readGroup(rawId: string, queries: (groupId: Query) => Query[] = () => []) {
  if (!Number.isInteger(Number(rawId))) await requireUser();
  const groupId = parseGroupId(rawId);
  const { user, rows: [groups, ...rows] } = await readSession((viewerId) => [
    sql`SELECT g.id, g.name, g.currency, g.invite_code, g.created_by,
      EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = ${viewerId}) AS is_member,
      EXISTS (SELECT 1 FROM recurring_expenses r
        WHERE r.group_id = g.id AND r.active AND r.next_date <= CURRENT_DATE) AS recurring_due
      FROM groups g WHERE g.id = ${groupId}`,
    ...queries(sql`(SELECT gm.group_id FROM group_members gm
      WHERE gm.group_id = ${groupId} AND gm.user_id = ${viewerId})`),
  ], (viewer) => requireGroupMember(groupId, viewer.id));
  const group = groups[0];
  if (!group) notFound();
  if (!group.is_member) forbidden("You are not a member of this group");
  return {
    user,
    group: {
      id: Number(group.id), name: group.name as string, currency: group.currency as string,
      inviteCode: group.invite_code as string, createdBy: Number(group.created_by),
    },
    recurringDue: Boolean(group.recurring_due),
    rows,
  };
}
