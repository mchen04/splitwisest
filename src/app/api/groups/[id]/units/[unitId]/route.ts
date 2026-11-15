import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler, notFound } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { parseGroupId, requireGroupMember } from "@/lib/groups";
import { deleteGroupUnit, renameGroupUnit } from "@/lib/group-units";

type Ctx = { params: Promise<{ id: string; unitId: string }> };

const Body = z.object({ name: z.string().trim().min(1, "Unit name is required").max(40) });

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const { id, unitId: rawUnitId } = await params;
  const groupId = parseGroupId(id);
  const unitId = Number(rawUnitId);
  if (!Number.isInteger(unitId)) notFound();
  await requireGroupMember(groupId, user.id);
  const { name } = Body.parse(await req.json());
  const unit = await renameGroupUnit(groupId, unitId, user.id, name);
  return NextResponse.json(unit);
});

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const { id, unitId: rawUnitId } = await params;
  const groupId = parseGroupId(id);
  const unitId = Number(rawUnitId);
  if (!Number.isInteger(unitId)) notFound();
  await requireGroupMember(groupId, user.id);
  await deleteGroupUnit(groupId, unitId, user.id);
  return NextResponse.json({ ok: true });
});
