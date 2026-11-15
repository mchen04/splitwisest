import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, handler, forbidden } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { suggestSettlements } from "@/lib/balances";
import { sql } from "@/lib/db";
import { materializeRecurring } from "@/lib/expenses";
import {
  deleteGroup, parseGroupId, renameGroupWithActivity, requireGroupMember, requireGroupViewerVersions,
  setGroupAutoReconcile,
} from "@/lib/groups";
import { computeUnitBalancesFromAggregates, parseUnitAggregates } from "@/lib/units";

type Ctx = { params: Promise<{ id: string }> };

export const GET = privateHandler(async (req: NextRequest, { params }: Ctx) => {
  let group = await requireGroupViewerVersions((await params).id, true);
  const groupId = group.id;

  // materializeRecurring writes (must run first); members + balances are then
  // independent reads — run them as one parallel level over the Neon driver.
  await materializeRecurring(groupId);
  if (group.versions.recurringDue) group = await requireGroupViewerVersions(String(groupId), true);
  const { members, balances } = group;
  const suggestions = suggestSettlements(balances);
  const memberIds = members.map((member) => member.id);
  const aggregate = parseUnitAggregates(group.unitData);
  const unitBalances = aggregate.units.map((unit) => {
    const result = computeUnitBalancesFromAggregates(
      memberIds,
      unit.id,
      unit.name,
      aggregate.totals.filter((row) => row.unitId === unit.id),
      aggregate.directed.filter((row) => row.unitId === unit.id),
      group.autoReconcileUnits
    );
    const displayName = new Map(members.map((member) => [member.id, member.displayName]));
    return {
      unitId: unit.id,
      name: unit.name,
      reconcile: group.autoReconcileUnits,
      nets: result.nets.map((row) => ({ ...row, displayName: displayName.get(row.userId) ?? "" })),
      gross: result.gross,
      transfers: result.transfers,
      obligations: result.obligations,
    };
  });
  const unitUserIds = [...new Set(unitBalances.flatMap((unit) => [
    ...unit.nets.map((row) => row.userId),
    ...unit.gross.map((row) => row.userId),
  ]))];
  const unitPeople = unitUserIds.length === 0 ? [] : (await sql`
    SELECT id, display_name FROM users WHERE id = ANY(${unitUserIds})
  `).map((row) => ({
    userId: Number(row.id), displayName: String(row.display_name),
  }));

  return privateJson(req, {
    group: {
      id: groupId,
      name: group.name,
      currency: group.currency,
      inviteCode: group.inviteCode,
      createdBy: group.createdBy,
      autoReconcileUnits: group.autoReconcileUnits,
    },
    version: group.versions.detail,
    members,
    balances,
    suggestions,
    units: aggregate.units,
    unitBalances,
    unitPeople,
  });
});

const PatchBody = z.object({
  name: z.string().trim().min(1, "Group name is required").max(60).optional(),
  autoReconcileUnits: z.boolean().optional(),
});

// Rename a group. Any member may rename it; currency is immutable because
// existing expenses store amounts already converted to the group's currency.
export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  await requireGroupMember(groupId, user.id);
  const body = PatchBody.parse(await req.json());
  if (body.name === undefined && body.autoReconcileUnits === undefined) {
    badRequest("Nothing to update");
  }
  if (body.name !== undefined) await renameGroupWithActivity(groupId, user, body.name);
  const autoReconcileUnits = body.autoReconcileUnits === undefined
    ? undefined
    : await setGroupAutoReconcile(groupId, user.id, body.autoReconcileUnits);
  return NextResponse.json({ ok: true, autoReconcileUnits });
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
