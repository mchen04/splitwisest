import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { deliverNotifications } from "@/lib/notification-delivery";
import { sql } from "@/lib/db";

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const secret = process.env.PUSH_CRON_SECRET;
  const value = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || secret.length < 32 || value.length !== expected.length || !timingSafeEqual(value, expected)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  try {
    const result = await deliverNotifications();
    await sql`DELETE FROM notifications WHERE id IN
      (SELECT id FROM notifications WHERE created_at < now() - interval '90 days' ORDER BY id LIMIT 500)`;
    await sql`DELETE FROM push_subscriptions WHERE id IN
      (SELECT s.id FROM push_subscriptions s JOIN sessions sess ON sess.token = s.session_token
        WHERE sess.expires_at <= now() ORDER BY s.id LIMIT 100)`;
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Delivery will retry on the next run" }, { status: 503 });
  }
}
