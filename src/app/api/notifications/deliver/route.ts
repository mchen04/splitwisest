import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { deliverNotifications } from "@/lib/notification-delivery";
import { sql } from "@/lib/db";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Vercel Cron sends GET with `Bearer $CRON_SECRET`; production sets CRON_SECRET to PUSH_CRON_SECRET.
// The GitHub workflow and manual runs use POST with the same secret.
async function deliver(req: NextRequest) {
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
    const trigger = req.headers.get("user-agent")?.startsWith("vercel-cron") ? "vercel-cron" : "manual";
    console.info(JSON.stringify({ event: "notification-delivery", trigger, ...result }));
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Delivery will retry on the next run" }, { status: 503 });
  }
}

export const GET = deliver;
export const POST = deliver;
