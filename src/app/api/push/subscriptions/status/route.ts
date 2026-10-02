import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const { endpoint } = z.object({ endpoint: z.string().max(2048) }).parse(await req.json());
  const rows = await sql`SELECT s.id FROM push_subscriptions s
    JOIN sessions sess ON sess.token = s.session_token AND sess.expires_at > now()
    WHERE s.user_id = ${user.id} AND sess.user_id = ${user.id} AND s.endpoint = ${endpoint}`;
  return NextResponse.json({ id: rows[0] ? Number(rows[0].id) : null });
});
