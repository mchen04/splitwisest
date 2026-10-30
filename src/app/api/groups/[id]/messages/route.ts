import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { readGroup } from "@/app/api/_lib/read-group";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler, forbidden } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { insertGroupMessage, loadGroupMessages } from "@/lib/messages";
import { parseGroupId, requireGroupMember } from "@/lib/groups";

type Ctx = { params: Promise<{ id: string }> };

export const GET = privateHandler(async (req: NextRequest, { params }: Ctx) => {
  const { group } = await readGroup((await params).id);
  return privateJson(req, await loadGroupMessages(group.id, req.nextUrl.searchParams));
});

const Body = z.object({ body: z.string().trim().min(1, "Message is empty").max(4000) });

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  await requireGroupMember(groupId, user.id);
  const { body } = Body.parse(await req.json());
  const id = await insertGroupMessage(groupId, user.id, body);
  if (id === null) forbidden("You are not a member of this group");
  return NextResponse.json({ id });
});
