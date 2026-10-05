import { NextRequest, NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireGroupViewerVersions } from "@/lib/groups";

type Ctx = { params: Promise<{ id: string }> };

// Cheap per-tick check for an open group page: fingerprints of the group
// detail and group-balance list, so the page refetches only what changed. The
// session check runs inside the same statement (one round trip per tick).
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { versions } = await requireGroupViewerVersions((await params).id);
  return NextResponse.json(versions);
});
