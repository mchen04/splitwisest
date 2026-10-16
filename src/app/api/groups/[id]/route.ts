import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, handler, forbidden } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { suggestSettlements } from "@/lib/balances";
import { materializeRecurring } from "@/lib/expenses";
import {
  deleteGroup, parseGroupId, renameGroupWithActivity, requireGroupMember, requireGroupViewerVersions,
} from "@/lib/groups";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  let group = await requireGroupViewerVersions((await params).id, true);
  const groupId = group.id;

  // materializeRecurring writes (must run first); members + balances are then
  // independent reads — run them as one parallel level over the Neon driver.
  await materializeRecurring(groupId);
  if (group.versions.recurringDue) group = await requireGroupViewerVersions(String(groupId), true);
  const { members, balances } = group;
  const suggestions = suggestSettlements(balances);

  return NextResponse.json({
    group: {
      id: groupId,
      name: group.name,
      currency: group.currency,
      inviteCode: group.inviteCode,
      createdBy: group.createdBy,
    },
    version: group.versions.detail,
    members,
    balances,
    suggestions,
  });
});

const PatchBody = z.object({ name: z.string().trim().min(1, "Group name is required").max(60) });

// Rename a group. Any member may rename it; currency is immutable because
// existing expenses store amounts already converted to the group's currency.
export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  await requireGroupMember(groupId, user.id);
  const { name } = PatchBody.parse(await req.json());
  await renameGroupWithActivity(groupId, user, name);
  return NextResponse.json({ ok: true });
});

// Delete a group and everything in it. Restricted to the group's creator;
// ON DELETE CASCADE removes members, expenses, shares, settlements, messages,
// recurring rules, and group activity.
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  const group = await requireGroupMember(groupId, user.id);
  if (group.createdBy !== user.id) forbidden("Only the group's creator can delete it");
  const result = await deleteGroup(groupId, user);
  if (!result.deleted && result.outstandingBalances > 0) {
    badRequest("Settle all balances in this group before deleting it");
  }
  if (!result.deleted && result.activeRecurring > 0) {
    badRequest("Stop all recurring expenses before deleting this group");
  }
  if (!result.deleted) forbidden("Only the group's creator can delete it");
  return NextResponse.json({ ok: true });
});
