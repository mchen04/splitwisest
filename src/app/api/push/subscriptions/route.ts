import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler, ApiError } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { assertNotificationRateLimit, notificationSessionToken } from "@/lib/notifications";
import { pushAllowedFor, pushKeys, validPushEndpoint, validSubscriptionKeys } from "@/lib/web-push";

const Endpoint = z.string().max(2048).refine(validPushEndpoint, "Unsupported push service");
const Body = z.object({ endpoint: Endpoint, p256dh: z.string().max(100), auth: z.string().max(30),
  label: z.string().trim().min(1).max(80), publicKey: z.string().max(100),
}).strict().refine((v) => validSubscriptionKeys(v.p256dh, v.auth), "Invalid subscription keys");

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const keys = pushKeys();
  if (!keys || !pushAllowedFor(user.id)) throw new ApiError("Phone notifications are not available for this account yet", 503);
  await assertNotificationRateLimit(user.id, "subscribe", 20);
  const body = Body.parse(await req.json());
  if (body.publicKey !== keys.publicKey) throw new ApiError("Notification settings changed. Refresh and try again", 409);
  const token = await notificationSessionToken();
  const [, , rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(174829, ${user.id}::int)`,
    tx`DELETE FROM push_subscriptions sub USING sessions sess
      WHERE sub.session_token = sess.token AND sub.user_id = ${user.id} AND sess.expires_at <= now()`,
    tx`INSERT INTO push_subscriptions(user_id, session_token, endpoint, p256dh, auth, vapid_key, label)
      SELECT ${user.id}, ${token}, ${body.endpoint}, ${body.p256dh}, ${body.auth}, ${keys.publicKey}, ${body.label}
      WHERE (SELECT count(*) FROM push_subscriptions WHERE user_id = ${user.id}) < 10
        OR EXISTS(SELECT 1 FROM push_subscriptions WHERE user_id = ${user.id} AND endpoint = ${body.endpoint})
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_token = excluded.session_token,
        p256dh = excluded.p256dh, auth = excluded.auth, vapid_key = excluded.vapid_key,
        label = excluded.label, updated_at = now()
      RETURNING id`,
  ]);
  if (!rows[0]) throw new ApiError("Remove an old device before adding another", 409);
  return NextResponse.json({ id: Number(rows[0].id) });
});

const RemoveBody = z.object({ id: z.number().int().positive().optional(), endpoint: Endpoint.optional() })
  .refine((v) => Boolean(v.id) !== Boolean(v.endpoint), "Choose one device");
export const DELETE = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const body = RemoveBody.parse(await req.json());
  await sql`DELETE FROM push_subscriptions WHERE user_id = ${user.id}
    AND (id = ${body.id ?? null} OR endpoint = ${body.endpoint ?? null})`;
  return NextResponse.json({ ok: true });
});
