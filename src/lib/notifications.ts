import { cookies } from "next/headers";
import { sql } from "./db";
import { ApiError } from "./api";
import { NOTIFICATION_CATEGORIES, type NotificationCategory, type NotificationItem } from "./notification-types";
import { pushAllowedFor, pushKeys } from "./web-push";

export function mapNotification(row: Record<string, unknown>): NotificationItem {
  return { id: Number(row.id), category: row.category as NotificationItem["category"],
    title: String(row.title), body: String(row.body), href: String(row.href),
    createdAt: String(row.created_at), readAt: row.read_at ? String(row.read_at) : null };
}

export async function notificationSettings(userId: number) {
  const [prefs, devices] = await sql.transaction((tx) => [
    tx`SELECT push_enabled, categories FROM notification_preferences WHERE user_id = ${userId}`,
    tx`SELECT s.id, s.label, s.updated_at FROM push_subscriptions s
      JOIN sessions sess ON sess.token = s.session_token AND sess.expires_at > now()
      WHERE s.user_id = ${userId} ORDER BY s.updated_at DESC`,
  ]);
  const categories = Object.fromEntries(Object.keys(NOTIFICATION_CATEGORIES).map((key) =>
    [key, prefs[0]?.categories?.[key] !== false])) as Record<NotificationCategory, boolean>;
  return {
    preferences: { pushEnabled: prefs[0]?.push_enabled !== false, categories },
    devices: devices.map((d) => ({ id: Number(d.id), label: String(d.label), updatedAt: String(d.updated_at) })),
    publicKey: pushAllowedFor(userId) ? pushKeys()?.publicKey ?? null : null,
  };
}

export async function notificationSessionToken(): Promise<string> {
  const token = (await cookies()).get("sw_session")?.value;
  if (!token) throw new ApiError("Please log in again", 401);
  return token;
}

export async function assertNotificationRateLimit(userId: number, action: string, limit: number) {
  const rows = await sql`INSERT INTO auth_rate_limits(scope, key, window_start, attempts)
    VALUES (${`notification:${action}`}, ${String(userId)}, now(), 1)
    ON CONFLICT(scope, key) DO UPDATE SET
      window_start = CASE WHEN auth_rate_limits.window_start < now() - interval '1 minute' THEN now() ELSE auth_rate_limits.window_start END,
      attempts = CASE WHEN auth_rate_limits.window_start < now() - interval '1 minute' THEN 1 ELSE auth_rate_limits.attempts + 1 END
    RETURNING attempts`;
  if (Number(rows[0].attempts) > limit) throw new ApiError("Please wait a minute before trying again", 429);
}
