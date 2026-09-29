import { NextRequest, NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadGroupObligation, updateGroupObligation, deleteGroupObligation } from "@/lib/group-obligations";
import { GroupObligationBody } from "@/lib/group-obligation-math";
import { VersionToken } from "@/lib/versions";

type Ctx = { params: Promise<{ id: string }> };

function balanceId(raw: string) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  return id;
}

export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const balance = await loadGroupObligation(balanceId((await params).id), user.id);
  return NextResponse.json({ balance });
});

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = balanceId((await params).id);
  const current = await loadGroupObligation(id, user.id);
  const input = GroupObligationBody.parse(await req.json());
  await updateGroupObligation(id, current.groupId, current.currency, user, input);
  return NextResponse.json({ ok: true });
});

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const id = balanceId((await params).id);
  const current = await loadGroupObligation(id, user.id);
  const expectedUpdatedAt = VersionToken.parse(req.nextUrl.searchParams.get("expectedUpdatedAt"));
  await deleteGroupObligation(id, current.groupId, user, expectedUpdatedAt);
  return NextResponse.json({ ok: true });
});
