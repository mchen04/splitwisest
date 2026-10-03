import { randomUUID } from "node:crypto";
import { sql } from "./db";
import { allowedPushUsers, pushKeys, sendPush } from "./web-push";
import { monthlyBalanceOutstanding } from "./monthly-reminders";

export async function deliverNotifications(send = sendPush) {
  const keys = pushKeys();
  const allowed = allowedPushUsers();
  const totals = { accepted: 0, retried: 0, removed: 0, skipped: 0, failed: 0 };
  if (!keys || allowed?.length === 0) return totals;
  const lease = randomUUID();
  const jobs = await sql`
    WITH due AS (
      SELECT d.notification_id, d.subscription_id
      FROM notification_deliveries d
      JOIN push_subscriptions s ON s.id = d.subscription_id
      JOIN notifications n ON n.id = d.notification_id
      WHERE d.state IN ('pending','sending') AND d.next_attempt_at <= now()
        AND (d.lease_until IS NULL OR d.lease_until < now())
        AND s.vapid_key = ${keys.publicKey}
        AND (${allowed}::bigint[] IS NULL OR n.user_id = ANY(${allowed}::bigint[]))
      ORDER BY d.next_attempt_at, d.notification_id
      LIMIT 24 FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE notification_deliveries d SET state = 'sending', attempts = attempts + 1,
      lease_until = now() + interval '2 minutes', lease_token = ${lease}, updated_at = now()
    FROM due WHERE d.notification_id = due.notification_id AND d.subscription_id = due.subscription_id
    RETURNING d.notification_id, d.subscription_id, d.attempts`;

  // Four sends at a time keep a 24-job batch within a 60-second function budget.
  for (let i = 0; i < jobs.length; i += 4) {
    await Promise.all(jobs.slice(i, i + 4).map(async (job) => {
      const rows = await sql`
        SELECT s.endpoint, s.p256dh, s.auth, n.id, n.category, n.type, n.user_id, n.group_id,
          (s.user_id = n.user_id AND sess.user_id = n.user_id AND sess.expires_at > now()
            AND u.deleted_at IS NULL AND notification_visible(n)
            AND n.created_at > now() - interval '24 hours'
            AND (n.category = 'test' OR (n.read_at IS NULL AND COALESCE(p.push_enabled, true)
              AND COALESCE((p.categories->>n.category)::boolean, true)))) AS eligible
        FROM notification_deliveries d
        JOIN push_subscriptions s ON s.id = d.subscription_id
        JOIN sessions sess ON sess.token = s.session_token
        JOIN notifications n ON n.id = d.notification_id
        JOIN users u ON u.id = n.user_id
        LEFT JOIN notification_preferences p ON p.user_id = n.user_id
        WHERE d.notification_id = ${job.notification_id} AND d.subscription_id = ${job.subscription_id}
          AND d.lease_token = ${lease} AND s.vapid_key = ${keys.publicKey}`;
      const row = rows[0];
      if (!row) return;
      let state = "skipped"; let status: number | null = null; let retrySeconds = 0;
      const eligible = row.eligible && (row.type !== "reminder.monthly"
        || await monthlyBalanceOutstanding(Number(row.user_id), row.group_id === null ? null : Number(row.group_id)));
      if (eligible) {
        // A configuration error never deletes a working subscription or leaks its endpoint.
        const result = await send({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, {
          notificationId: Number(row.id), url: `/notifications/${row.id}`, test: row.category === "test",
        }, keys).catch(() => ({ outcome: "retry" as const, status: null }));
        status = result.status;
        if (result.outcome === "gone") {
          await sql`DELETE FROM push_subscriptions WHERE id = ${job.subscription_id} AND endpoint = ${row.endpoint}`;
          totals.removed++;
          return;
        }
        if (result.outcome === "sent") { state = "sent"; totals.accepted++; }
        else if (result.outcome === "retry" && Number(job.attempts) < 8) {
          state = "pending";
          retrySeconds = "retryAfter" in result && result.retryAfter ? result.retryAfter : Math.min(3600, 60 * 2 ** (Number(job.attempts) - 1));
          totals.retried++;
        } else { state = "failed"; totals.failed++; }
      } else { totals.skipped++; }
      await sql`UPDATE notification_deliveries SET state = ${state}, last_status = ${status},
        next_attempt_at = now() + ${retrySeconds} * interval '1 second', lease_until = NULL,
        lease_token = NULL, updated_at = now()
        WHERE notification_id = ${job.notification_id} AND subscription_id = ${job.subscription_id} AND lease_token = ${lease}`;
    }));
  }
  return totals;
}
