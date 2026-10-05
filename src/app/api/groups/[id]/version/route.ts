import { NextRequest, NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireSessionToken, requireUser } from "@/lib/auth";
import { parseGroupId, requireGroupMemberVersions } from "@/lib/groups";

type Ctx = { params: Promise<{ id: string }> };

// Cheap per-tick check for an open group page: fingerprints of the group
// detail and group-balance list, so the page refetches only what changed. The
// session check runs inside the same statement (one round trip per tick).
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const token = await requireSessionToken();
  const id = (await params).id;
  // A malformed id keeps the old order: an invalid session still answers 401.
  if (!Number.isInteger(Number(id))) await requireUser();
  const { versions } = await requireGroupMemberVersions(parseGroupId(id), { token });
  return NextResponse.json(versions);
});
