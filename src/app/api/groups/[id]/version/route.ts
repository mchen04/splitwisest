import { NextRequest, NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { parseGroupId, requireGroupMemberVersions } from "@/lib/groups";

type Ctx = { params: Promise<{ id: string }> };

// Cheap per-tick check for an open group page: fingerprints of the group
// detail and group-balance list, so the page refetches only what changed.
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const groupId = parseGroupId((await params).id);
  const { versions } = await requireGroupMemberVersions(groupId, user.id);
  return NextResponse.json(versions);
});
