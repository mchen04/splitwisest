import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { parseGroupId, requireGroupMember } from "@/lib/groups";
import { createGroupUnit, listGroupUnits } from "@/lib/group-units";

type Ctx = { params: Promise<{ id: string }> };

export const GET = privateHandler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  await requireGroupMember(groupId, user.id);
  return privateJson(req, { units: await listGroupUnits(groupId) });
});

const Body = z.object({ name: z.string().trim().min(1, "Unit name is required").max(40) });

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  await requireGroupMember(groupId, user.id);
  const { name } = Body.parse(await req.json());
  const unit = await createGroupUnit(groupId, user.id, name);
  return NextResponse.json(unit);
});
