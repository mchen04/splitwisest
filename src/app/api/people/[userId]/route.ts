import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { NextRequest } from "next/server";
import { notFound } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadPersonProfile } from "@/lib/people";

type Ctx = { params: Promise<{ userId: string }> };

export const GET = privateHandler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const personId = Number((await params).userId);
  if (!Number.isInteger(personId)) notFound();

  const profile = await loadPersonProfile(user.id, personId);
  if (!profile) notFound("Profile not available");

  return privateJson(req, { profile });
});
