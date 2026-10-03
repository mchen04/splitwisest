import { sql } from "./db";

// Business dates use UTC. The existing daily cron runs at 17:00 UTC.
export function monthlyReminderPeriod(now: Date): string | null {
  if (Number.isNaN(now.getTime()) || now.getUTCDate() !== 1 || now.getUTCHours() < 17) return null;
  return now.toISOString().slice(0, 7);
}

export async function monthlyBalanceOutstanding(userId: number, groupId: number | null): Promise<boolean> {
  const rows = groupId !== null
    ? await sql`SELECT 1 FROM group_balance_rows(${groupId}) WHERE user_id = ${userId} AND net_cents <> 0 LIMIT 1`
    : await sql`SELECT 1 FROM settlements s
        JOIN friendships f ON f.user_a = LEAST(s.payer_id, s.recipient_id)
          AND f.user_b = GREATEST(s.payer_id, s.recipient_id)
        WHERE s.group_id IS NULL AND (s.payer_id = ${userId} OR s.recipient_id = ${userId})
        GROUP BY CASE WHEN s.payer_id = ${userId} THEN s.recipient_id ELSE s.payer_id END, s.currency
        HAVING SUM(CASE WHEN s.payer_id = ${userId} THEN s.converted_cents ELSE -s.converted_cents END) <> 0
        LIMIT 1`;
  return rows.length > 0;
}

export async function enqueueMonthlyReminders(now = new Date(), userIds: number[] | null = null): Promise<number> {
  const period = monthlyReminderPeriod(now);
  if (!period || userIds?.length === 0) return 0;

  // One statement preserves the inbox/outbox transaction. The existing unique key
  // arbitrates concurrent scheduler calls, including a retry after a lost response.
  const rows = await sql`
    WITH group_recipients AS (
      SELECT b.user_id, 'monthly:' || ${period} || ':group:' || g.id AS event_key,
        'You have an outstanding balance in ' || g.name || '. Open the group balances to review and settle up.' AS body,
        '/groups/' || g.id || '?tab=balances' AS href, g.id AS group_id
      FROM groups g
      CROSS JOIN LATERAL group_balance_rows(g.id) b
      WHERE b.net_cents <> 0
        AND (${userIds}::bigint[] IS NULL OR b.user_id = ANY(${userIds}::bigint[]))
    ), direct_pairs AS (
      SELECT LEAST(s.payer_id, s.recipient_id) AS user_a,
        GREATEST(s.payer_id, s.recipient_id) AS user_b, s.currency
      FROM settlements s
      JOIN friendships f ON f.user_a = LEAST(s.payer_id, s.recipient_id)
        AND f.user_b = GREATEST(s.payer_id, s.recipient_id)
      WHERE s.group_id IS NULL
        AND (${userIds}::bigint[] IS NULL OR s.payer_id = ANY(${userIds}::bigint[])
          OR s.recipient_id = ANY(${userIds}::bigint[]))
      GROUP BY LEAST(s.payer_id, s.recipient_id), GREATEST(s.payer_id, s.recipient_id), s.currency
      HAVING SUM(CASE WHEN s.payer_id < s.recipient_id THEN s.converted_cents ELSE -s.converted_cents END) <> 0
    ), recipients AS (
      SELECT * FROM group_recipients
      UNION ALL
      SELECT DISTINCT id, 'monthly:' || ${period} || ':direct',
        'You have outstanding balances with friends. Open Balances to review and settle up.',
        '/balances', NULL::bigint
      FROM direct_pairs CROSS JOIN LATERAL unnest(ARRAY[user_a, user_b]) id
      WHERE ${userIds}::bigint[] IS NULL OR id = ANY(${userIds}::bigint[])
    )
    INSERT INTO notifications(user_id, event_key, category, type, title, body, href, group_id)
    SELECT r.user_id, r.event_key, 'reminders', 'reminder.monthly',
      'Monthly settle-up reminder', r.body, r.href, r.group_id
    FROM recipients r JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
    ORDER BY r.user_id, r.event_key
    ON CONFLICT(user_id, event_key) DO NOTHING
    RETURNING id`;
  return rows.length;
}
