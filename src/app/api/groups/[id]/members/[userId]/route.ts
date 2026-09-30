import { NextRequest, NextResponse } from "next/server";
import { handler, notFound, forbidden, badRequest } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { isGroupMember } from "@/lib/balances";
import { parseGroupId, removeGroupMemberWithActivity, requireGroupMember } from "@/lib/groups";

type Ctx = { params: Promise<{ id: string; userId: string }> };

// Remove a member from a group (or leave it, when removing yourself). Allowed
// only when that member is settled up (net zero) so the ledger stays balanced;
// removing someone other than yourself is restricted to the group's creator.
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const { id, userId } = await params;
  const groupId = parseGroupId(id);
  const targetId = Number(userId);
  if (!Number.isInteger(targetId)) notFound();
  const group = await requireGroupMember(groupId, user.id);
  if (!(await isGroupMember(groupId, targetId))) notFound("That person is not in this group");

  const isCreator = group.createdBy === user.id;
  const removingSelf = targetId === user.id;
  if (!removingSelf && !isCreator) forbidden("Only the group's creator can remove other members");
  if (removingSelf && isCreator) {
    badRequest("The group's creator can't leave — delete the group instead, or transfer it first");
  }

  const result = await removeGroupMemberWithActivity({ groupId, targetId, actor: user, removingSelf });
  if (!result.removed && result.groupBalanceRefs > 0) {
    badRequest(
      removingSelf
        ? "Edit or delete group balances that include you before leaving"
        : "Edit or delete group balances that include this member before removing them"
    );
  }
  if (!result.removed && result.netCents !== 0) {
    badRequest(
      removingSelf
        ? "Settle up your balance in this group before leaving"
        : "That member still has an outstanding balance — settle it up first"
    );
  }
  if (!result.removed && result.activeRecurringRefs > 0) {
    badRequest(
      removingSelf
        ? "Stop or update recurring expenses that include you before leaving"
        : "Stop or update recurring expenses that include this member before removing them"
    );
  }
  if (!result.removed) notFound("That person is not in this group");
  return NextResponse.json({ ok: true, left: removingSelf });
});
