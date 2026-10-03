import { randomBytes, createECDH } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql } from "../src/lib/db";
import { hashPassword, newInviteCode, newToken } from "../src/lib/auth";
import { enqueueMonthlyReminders, monthlyBalanceOutstanding } from "../src/lib/monthly-reminders";
import { deliverNotifications } from "../src/lib/notification-delivery";
import { pushKeys } from "../src/lib/web-push";

const hosted = process.argv.includes("--hosted");
const keep = process.argv.includes("--keep");
const database = new URL(process.env.DATABASE_URL!);
if (hosted ? process.env.VERCEL !== "1" || keep
  : database.pathname !== "/splitwisest_monthly_qa" || !["db.localtest.me", "localhost", "127.0.0.1"].includes(database.hostname)) {
  throw new Error("Use the isolated monthly database, or an explicit hosted fixture run without --keep");
}
const suffix = randomBytes(6).toString("hex");
const password = randomBytes(24).toString("base64url");
const users: { id: number; role: string; username: string; token: string }[] = [];
const groups: number[] = [];
const receipts: string[] = [];
function check(value: unknown, name: string): asserts value {
  if (!value) throw new Error(name);
  receipts.push(name);
}
const financialTables = ["expenses", "expense_shares", "expense_items", "settlements", "group_obligations",
  "group_obligation_allocations", "group_obligation_create_requests", "recurring_expenses", "attachments"];
async function financialSnapshot() {
  return sql.transaction(financialTables.map((table) => sql.query(
    `SELECT '${table}' AS table_name, count(*)::int AS rows,
      md5(COALESCE(string_agg(hash, '' ORDER BY hash), '')) AS checksum
      FROM (SELECT md5(to_jsonb(t)::text) AS hash FROM ${table} t) hashes`)));
}
async function user(role: string) {
  const username = `monthly_${role}_${suffix}`;
  const rows = await sql`INSERT INTO users(username, display_name, password_hash, invite_code)
    VALUES (${username}, ${`Monthly Test ${role}`}, ${hashPassword(password)}, ${newInviteCode()}) RETURNING id`;
  const fixture = { id: Number(rows[0].id), role, username, token: newToken() };
  users.push(fixture);
  await sql`INSERT INTO sessions(token, user_id, expires_at) VALUES (${fixture.token}, ${fixture.id}, now() + interval '1 day')`;
  return fixture;
}
async function group(members: typeof users, label: string) {
  const rows = await sql`INSERT INTO groups(name,currency,invite_code,created_by)
    VALUES (${`Monthly Test ${label}`}, 'USD', ${newInviteCode()}, ${members[0].id}) RETURNING id`;
  const id = Number(rows[0].id); groups.push(id);
  await sql`INSERT INTO group_members(group_id,user_id) SELECT ${id}, unnest(${members.map((u) => u.id)}::bigint[])`;
  return id;
}
async function obligation(gid: number, debtor: typeof users[number], creditor: typeof users[number]) {
  await sql`WITH obligation AS (
    INSERT INTO group_obligations(group_id,title,amount_cents,owed_method,receive_method,created_by)
    VALUES (${gid}, 'Monthly fixture balance', 250, 'exact', 'exact', ${creditor.id}) RETURNING id
  ) INSERT INTO group_obligation_allocations(obligation_id,side,user_id,share_cents)
    SELECT id, 'owes', ${debtor.id}::bigint, 250 FROM obligation
    UNION ALL SELECT id, 'receives', ${creditor.id}, 250 FROM obligation`;
}
async function direct(payer: typeof users[number], recipient: typeof users[number], currency: string, cents: number) {
  await sql`INSERT INTO settlements(payer_id,recipient_id,amount_cents,currency,converted_cents,settled_date,created_by)
    VALUES (${payer.id}, ${recipient.id}, ${cents}, ${currency}, ${cents}, CURRENT_DATE, ${payer.id})`;
}
async function cleanup() {
  if (!users.length) return;
  const ids = users.map((u) => u.id);
  // These IDs originate only from this run. Financial rows never reference outside users.
  await sql.transaction((tx) => [
    tx`DELETE FROM groups WHERE id = ANY(${groups}::bigint[])`,
    tx`DELETE FROM settlements WHERE group_id IS NULL AND payer_id = ANY(${ids}::bigint[]) AND recipient_id = ANY(${ids}::bigint[])`,
    tx`DELETE FROM users WHERE id = ANY(${ids}::bigint[])`,
  ]);
}

async function main() {
  const before = await financialSnapshot();
  let retained = false;
  try {
    const debtor = await user("debtor"), creditor = await user("creditor"), zero = await user("zero");
    const muted = await user("muted"), disabled = await user("disabled"), deleted = await user("deleted");
    const directA = await user("directA"), directB = await user("directB");
    const outsider = await user("outsider"), outsidePeer = await user("outsidePeer");
    const scope = users.filter((u) => ![outsider.id, outsidePeer.id].includes(u.id)).map((u) => u.id);
    // The deployment allowlist changes only in this verification process. Sends use an injected transport.
    process.env.PUSH_ALLOWED_USER_IDS = scope.join(",");
    const expenseGroup = await group([creditor, debtor, zero, muted, disabled, deleted], "expenses");
    await sql`WITH expense AS (
      INSERT INTO expenses(group_id,title,amount_cents,currency,converted_cents,expense_date,payer_id,split_method,created_by)
      VALUES (${expenseGroup}, 'Monthly fixture expense', 800, 'USD', 800, CURRENT_DATE, ${creditor.id}, 'exact', ${creditor.id}) RETURNING id
    ) INSERT INTO expense_shares(expense_id,user_id,share_cents)
      SELECT id, unnest(${[debtor.id, muted.id, disabled.id, deleted.id]}::bigint[]), 200 FROM expense`;
    const balanceGroup = await group([creditor, debtor, zero], "group balances");
    await obligation(balanceGroup, debtor, creditor);
    const outsideGroup = await group([outsider, outsidePeer], "excluded scope");
    await obligation(outsideGroup, outsider, outsidePeer);
    const settledGroup = await group([zero, directA], "settled");
    await obligation(settledGroup, zero, directA);
    await sql`INSERT INTO settlements(group_id,payer_id,recipient_id,amount_cents,currency,converted_cents,settled_date,created_by)
      VALUES (${settledGroup}, ${zero.id}, ${directA.id}, 250, 'USD', 250, CURRENT_DATE, ${zero.id})`;
    await sql`INSERT INTO friendships(user_a,user_b) VALUES (${Math.min(directA.id, directB.id)}, ${Math.max(directA.id, directB.id)}),
      (${Math.min(directA.id, zero.id)}, ${Math.max(directA.id, zero.id)})`;
    await direct(directA, directB, "USD", 500);
    await direct(directB, directA, "EUR", 500);
    await direct(directA, zero, "USD", 100);
    await direct(zero, directA, "USD", 100);
    await direct(zero, directB, "USD", 100); // No friendship: not an accessible direct balance.
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${deleted.id}`;
    await sql`INSERT INTO notification_preferences(user_id,push_enabled,categories)
      VALUES (${muted.id}, true, '{"reminders":false}'::jsonb), (${disabled.id}, false, '{}'::jsonb)`;
    const key = pushKeys()?.publicKey ?? "fixture-only";
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    const p256dh = ecdh.getPublicKey().toString("base64url"), auth = randomBytes(16).toString("base64url");
    for (const who of [debtor, creditor, muted, disabled, deleted, directA, directB]) {
      await sql`INSERT INTO push_subscriptions(user_id,session_token,endpoint,p256dh,auth,vapid_key,label)
        VALUES (${who.id}, ${who.token}, ${`https://fcm.googleapis.com/fcm/send/monthly-fixture-${suffix}-${who.role}`},
          ${p256dh}, ${auth}, ${key}, 'Monthly fixture device')`;
    }
    const fixtureFinancial = await financialSnapshot();
    check(await monthlyBalanceOutstanding(debtor.id, expenseGroup) && await monthlyBalanceOutstanding(creditor.id, balanceGroup),
      "Delivery balance recheck recognizes both signs and both financial sources");
    check(!await monthlyBalanceOutstanding(zero.id, settledGroup) && !await monthlyBalanceOutstanding(zero.id, null),
      "Delivery balance recheck excludes settled groups and cancelled or inaccessible direct balances");
    const schema = await sql`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema()
      AND tablename IN ('notifications','notification_deliveries') ORDER BY indexname`;
    check(schema.some((r) => r.indexdef.includes("UNIQUE") && r.indexdef.includes("user_id, event_key")), "Schema readback: unique user/event key exists");
    const triggers = await sql`SELECT t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'notifications' AND t.tgname = 'notifications_queue_push'`;
    check(triggers.length === 1 && triggers[0].tgenabled === "O", "Schema readback: existing outbox trigger is enabled");
    for (const date of ["2026-10-31T23:59:59Z", "2026-11-01T16:59:59Z", "2026-11-02T00:00:00Z"]) {
      check(await enqueueMonthlyReminders(new Date(date), scope) === 0, `Outside first-day daytime window: ${date}`);
    }
    const time = new Date("2026-11-01T17:00:00Z");
    check(await enqueueMonthlyReminders(time, []) === 0, "Empty controlled scope emits nothing");
    const results = await Promise.all(Array.from({ length: 6 }, () => enqueueMonthlyReminders(time, scope)));
    check(results.reduce((sum, n) => sum + n, 0) === 8, "Six concurrent calls create exactly eight scoped reminders");
    const notifications = await sql`SELECT user_id,event_key,href,group_id FROM notifications
      WHERE user_id = ANY(${users.map((u) => u.id)}::bigint[]) AND type = 'reminder.monthly'`;
    check(notifications.length === 8, "Inbox: debtors and creditors receive one reminder per outstanding scope");
    check(notifications.filter((n) => Number(n.user_id) === debtor.id).length === 2, "Separate groups do not cancel each other's balances");
    check(!notifications.some((n) => [zero.id, deleted.id, outsider.id, outsidePeer.id].includes(Number(n.user_id))),
      "Zero, fully settled, deleted, inaccessible, and outside-scope accounts receive no reminder");
    check(notifications.filter((n) => n.group_id === null).length === 2, "Direct currency balances do not cancel across currencies; one direct reminder per user");
    check(notifications.every((n) => n.href === (n.group_id ? `/groups/${n.group_id}?tab=balances` : "/balances")), "Every reminder opens the actual balance scope");
    check(await enqueueMonthlyReminders(new Date("2026-11-01T23:59:59Z"), scope) === 0, "Lost-response and later same-day retries create zero duplicates");
    const deliveries = await sql`SELECT n.user_id,count(*)::int AS count FROM notification_deliveries d
      JOIN notifications n ON n.id = d.notification_id
      WHERE n.user_id = ANY(${scope}::bigint[]) AND n.type = 'reminder.monthly' GROUP BY n.user_id`;
    check(deliveries.reduce((sum, r) => sum + Number(r.count), 0) === 6, "Outbox: only opted-in devices queue six deliveries");
    check(!deliveries.some((r) => [muted.id, disabled.id].includes(Number(r.user_id))), "Category mute and global phone mute keep inbox entries without push jobs");
    await sql`UPDATE notification_preferences SET categories = '{}'::jsonb, push_enabled = true
      WHERE user_id IN (${muted.id}, ${disabled.id})`;
    check(await enqueueMonthlyReminders(time, scope) === 0, "Unmuting does not backfill this month's inbox or phone alerts");
    if (pushKeys()) {
      // Only this run's subscriptions can be claimed, even on a shared hosted database.
      await sql`INSERT INTO notification_preferences(user_id,categories) VALUES (${debtor.id}, '{"reminders":false}'::jsonb)`;
      let attempts = 0;
      const sends: number[] = [];
      const send: Parameters<typeof deliverNotifications>[0] = async (_subscription, payload) => {
        check(!payload.test && Object.keys(payload).sort().join(",") === "notificationId,test,url", "Delivery payload contains no financial details");
        sends.push(payload.notificationId);
        return attempts++ === 0 ? { outcome: "retry", status: 503 } : { outcome: "sent", status: 201 };
      };
      const batches = await Promise.all([deliverNotifications(send), deliverNotifications(send)]);
      check(batches.reduce((sum, r) => sum + r.retried, 0) === 1 && batches.reduce((sum, r) => sum + r.accepted, 0) === 3,
        "Concurrent delivery workers accept three jobs and retry one transient failure");
      check(batches.reduce((sum, r) => sum + r.skipped, 0) === 2, "Delivery rechecks reminder mute after enqueue");
      check(new Set(sends).size === sends.length, "Concurrent delivery leases prevent duplicate sends");
      await sql`UPDATE notification_deliveries d SET next_attempt_at = now() - interval '1 second'
        FROM notifications n WHERE n.id = d.notification_id AND n.user_id = ANY(${scope}::bigint[]) AND d.state = 'pending'`;
      const retry = await deliverNotifications(async () => ({ outcome: "sent", status: 201 }));
      check(retry.accepted === 1, "Transient delivery retry succeeds without creating another inbox item");
    }
    check(await enqueueMonthlyReminders(new Date("2026-12-01T17:00:00Z"), scope) === 8, "Next month creates eight new reminders");
    check(JSON.stringify(await financialSnapshot()) === JSON.stringify(fixtureFinancial), "Financial counts and checksums stay identical through all reminder and delivery checks");
    console.log(JSON.stringify({ evidence: "monthly-reminders", runtime: hosted ? "vercel-hosted-build-controlled" : "local-controlled",
      naturalFirstOfMonth: false, realPushProvider: false, physicalPhone: false, safari: false,
      checks: receipts, financialBeforeReminders: fixtureFinancial, financialAfterReminders: await financialSnapshot(), schema }, null, 2));
    if (pushKeys() && !keep) {
      await direct(directB, directA, "USD", 500);
      await direct(directA, directB, "EUR", 500);
      check(!await monthlyBalanceOutstanding(directA.id, null), "Both direct currency balances now settle to zero");
      const delivered: number[] = [];
      const results = await deliverNotifications(async (_subscription, payload) => {
        delivered.push(payload.notificationId); return { outcome: "sent", status: 201 };
      });
      check(results.skipped === 2 && results.accepted === 4, "Phone delivery skips two monthly reminders settled after enqueue");
      const directIds = await sql`SELECT id FROM notifications WHERE user_id IN (${directA.id}, ${directB.id}) AND type = 'reminder.monthly'`;
      check(!delivered.some((id) => directIds.some((n) => Number(n.id) === id)), "Settled direct reminders never reach the transport");
      console.log(JSON.stringify({ evidence: "settled-before-send", accepted: results.accepted, skipped: results.skipped, checks: receipts.slice(-3) }));
    }
    if (keep) {
      writeFileSync(".monthly-fixtures.local.json", JSON.stringify({ password, users, groups, expenseGroup, balanceGroup }, null, 2), { mode: 0o600 });
      retained = true;
      console.log("Controlled local fixtures retained in .monthly-fixtures.local.json (private; do not copy into evidence).");
    }
  } finally {
    if (!retained) {
      await cleanup();
      const after = await financialSnapshot();
      check(JSON.stringify(after) === JSON.stringify(before), "Cleanup restores original financial counts and checksums");
      console.log(JSON.stringify({ evidence: "financial-preservation", before, after, matches: true }));
    }
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && receipts.includes(error.message) ? "Monthly verification failed"
    : error instanceof Error && !error.name.includes("Neon") ? error.message : "Monthly verification failed; database details omitted");
  process.exitCode = 1;
  if (error && typeof error === "object" && "code" in error) console.error("Database error code:", error.code);
});
