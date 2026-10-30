import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { clearSession, requireSessionToken } from "@/lib/auth";

export const POST = handler(async () => {
  await requireSessionToken();
  await clearSession();
  return NextResponse.json({ ok: true });
});
