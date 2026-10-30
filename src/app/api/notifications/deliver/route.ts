import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { deliverNotifications } from "@/lib/notification-delivery";
import { enqueueMonthlyReminders } from "@/lib/monthly-reminders";

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
    const trigger = req.headers.get("user-agent")?.startsWith("vercel-cron") ? "vercel-cron" : "manual";
    const remindersCreated = await enqueueMonthlyReminders();
    const result = { ...await deliverNotifications(undefined, { cleanup: trigger === "vercel-cron" }), remindersCreated };
    console.info(JSON.stringify({ event: "notification-delivery", trigger, ...result }));
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Delivery will retry on the next run" }, { status: 503 });
  }
}

export const GET = deliver;
export const POST = deliver;
