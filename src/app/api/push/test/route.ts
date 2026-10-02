import { after, NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { handler, ApiError } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { assertNotificationRateLimit, notificationSessionToken } from "@/lib/notifications";
import { pushAllowedFor, pushKeys } from "@/lib/web-push";
import { deliverNotifications } from "@/lib/notification-delivery";

export const maxDuration = 60;
export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const id = z.coerce.number().int().positive().parse(req.nextUrl.searchParams.get("id"));
  const rows = await sql`SELECT d.state, d.attempts FROM notifications n
    LEFT JOIN notification_deliveries d ON d.notification_id = n.id
    WHERE n.id = ${id} AND n.user_id = ${user.id} AND n.category = 'test'`;
  if (!rows.length) throw new ApiError("Test not found", 404);
  return NextResponse.json({ state: rows[0].state ?? "failed", attempts: Number(rows[0].attempts ?? 0) },
    { headers: { "Cache-Control": "private, no-store" } });
});
export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser();
  if (!pushKeys() || !pushAllowedFor(user.id)) throw new ApiError("Phone notifications are not available", 503);
  await assertNotificationRateLimit(user.id, "test", 3);
  const { subscriptionId, delaySeconds } = z.object({ subscriptionId: z.number().int().positive(),
    delaySeconds: z.union([z.literal(0), z.literal(15)]).default(0) }).parse(await req.json());
  const token = await notificationSessionToken();
  const rows = await sql`
    WITH n AS (
      INSERT INTO notifications(user_id, event_key, category, type, title, body, href)
      SELECT ${user.id}, ${`test:${randomUUID()}`}, 'test', 'test', 'Test notification',
        'This test goes only to the device you selected.', '/notifications?test=opened'
      WHERE EXISTS(SELECT 1 FROM push_subscriptions WHERE id = ${subscriptionId}
        AND user_id = ${user.id} AND session_token = ${token})
      RETURNING id
    ), d AS (
      INSERT INTO notification_deliveries(notification_id, subscription_id, next_attempt_at)
      SELECT id, ${subscriptionId}, now() + ${delaySeconds} * interval '1 second' FROM n RETURNING notification_id
    ) SELECT notification_id FROM d`;
  if (!rows[0]) throw new ApiError("Reconnect this device before sending a test", 409);
  after(async () => {
    if (delaySeconds) await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    try { await deliverNotifications(); } catch { console.error("Test notification remains queued"); }
  });
  return NextResponse.json({ id: Number(rows[0].notification_id), queued: true, delaySeconds });
});
