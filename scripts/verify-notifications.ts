import { randomBytes, randomUUID, createECDH } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "../src/lib/db";
import { hashPassword, hashRecoveryCode, newInviteCode, createSession } from "../src/lib/auth";
import { deliverNotifications } from "../src/lib/notification-delivery";
import type { PushResult } from "../src/lib/web-push";
import webpush from "web-push";

const database = new URL(process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.pathname !== '/splitwisest_notifications_qa') {
  throw new Error("This suite only runs against the isolated local notification fixture database");
}
const origin = process.env.SPLITWISEST_BASE_URL ?? "http://localhost:3467";
if (!/^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) throw new Error("Use a local fixture server");
const suffix = randomBytes(5).toString("hex");
const password = randomBytes(24).toString("base64url");
const receipts: string[] = [];
const users: { id: number; username: string; cookie: string; token: string; inviteCode: string }[] = [];
function check(value: unknown, name: string): asserts value {
  if (!value) throw new Error(name);
  receipts.push(name);
}
async function call<T = Record<string, unknown>>(who: typeof users[number] | null, path: string,
  body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200): Promise<T> {
  const response = await fetch(origin + path, { method, headers: {
    ...(who ? { cookie: who.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status !== expected) throw new Error(`${method} ${path.split('?')[0]} expected ${expected}, got ${response.status}`);
  return response.json();
}
async function user(role: string) {
  const username = `notif_${role}_${suffix}`;
  const inviteCode = newInviteCode();
  const rows = await sql`INSERT INTO users(username, display_name, password_hash, invite_code)
    VALUES (${username}, ${`Notification Test ${role}`}, ${hashPassword(password)}, ${inviteCode}) RETURNING id`;
  const id = Number(rows[0].id); const token = await createSession(id);
  const fixture = { id, username, cookie: `sw_session=${token}`, token, inviteCode };
  users.push(fixture); return fixture;
}
async function lastId() { return Number((await sql`SELECT COALESCE(max(id),0) AS id FROM notifications`)[0].id); }
async function event(type: string, receiver: typeof users[number], work: () => Promise<unknown>, actor?: typeof users[number]) {
  const before = await lastId(); await work();
  const rows = await sql`SELECT * FROM notifications WHERE id > ${before} AND type = ${type}`;
  check(rows.filter((n) => Number(n.user_id) === receiver.id).length === 1, `${type}: one recipient notification`);
  if (actor) check(!rows.some((n) => Number(n.user_id) === actor.id), `${type}: no self alert`);
  return Number(rows.find((n) => Number(n.user_id) === receiver.id)!.id);
}
async function currentExpense(who: typeof users[number], id: number) {
  return (await call<{ expense: { updatedAt: string } }>(who, `/api/expenses/${id}`)).expense;
}
const subKeys = createECDH("prime256v1"); subKeys.generateKeys();
const p256dh = subKeys.getPublicKey().toString("base64url"); const auth = randomBytes(16).toString("base64url");

async function accountSwitches() {
  for (const route of ["login", "signup", "recover"]) {
    const previous = await user(`previous_${route}`);
    const target = route === "signup" ? null : await user(`target_${route}`);
    const otherToken = await createSession(previous.id);
    const subscriptions = await sql`INSERT INTO push_subscriptions(user_id, session_token, endpoint, p256dh, auth, vapid_key, label)
      SELECT ${previous.id}, token, ${`https://fcm.googleapis.com/fcm/send/switch-${suffix}-`} || token,
        ${p256dh}, ${auth}, 'fixture-only', 'Account switch fixture'
      FROM sessions WHERE token = ANY(${[previous.token, otherToken]}) RETURNING id, session_token`;
    const oldDevice = subscriptions.find((s) => s.session_token === previous.token)!;
    const otherDevice = subscriptions.find((s) => s.session_token === otherToken)!;
    const notification = await sql`INSERT INTO notifications(user_id,event_key,category,type,title,body,href)
      VALUES (${previous.id}, ${`switch:${suffix}:${route}`}, 'test','test','Switch fixture','Fixture only','/notifications') RETURNING id`;
    await sql`INSERT INTO notification_deliveries(notification_id, subscription_id)
      VALUES (${notification[0].id}, ${oldDevice.id})`;
    const code = randomBytes(8).toString("hex");
    if (route === "recover") await sql`INSERT INTO recovery_codes(user_id, code_hash)
      VALUES (${target!.id}, ${hashRecoveryCode(code)})`;
    const username = target?.username ?? `notif_new_${suffix}`;
    const body = route === "recover" ? { username, code, newPassword: password }
      : { username, password, ...(route === "signup" ? { displayName: "Notification Test Switch" } : {}) };
    const invalid = route === "login" ? { ...body, password: "wrong password" }
      : route === "recover" ? { ...body, code: "wrong code" } : { ...body, username: previous.username };
    await call(previous, `/api/auth/${route}`, invalid, "POST", 400);
    check((await sql`SELECT 1 FROM sessions WHERE token = ${previous.token}`).length === 1
      && (await sql`SELECT 1 FROM push_subscriptions WHERE id = ${oldDevice.id}`).length === 1,
    `${route}: rejected credentials preserve the current session and subscription`);
    const response = await fetch(origin + `/api/auth/${route}`, { method: "POST",
      headers: { cookie: previous.cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    check(response.status === 200, `${route}: account switch succeeds`);
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith("sw_session="))?.split(";")[0];
    check(cookie, `${route}: replacement session cookie is set`);
    const id = Number((await sql`SELECT id FROM users WHERE username = ${username}`)[0].id);
    if (!target) users.push({ id, username, cookie, token: cookie.slice("sw_session=".length), inviteCode: "" });
    const me = await call<{ user: { id: number } }>({ ...previous, cookie }, "/api/me");
    check(me.user.id === id, `${route}: new session belongs to the target account`);
    check((await sql`SELECT 1 FROM sessions WHERE token = ${previous.token}`).length === 0,
      `${route}: account switch revokes the previous session`);
    await call(previous, "/api/me", undefined, "GET", 401);
    check((await sql`SELECT 1 FROM push_subscriptions WHERE id = ${oldDevice.id}`).length === 0
      && (await sql`SELECT 1 FROM notification_deliveries WHERE subscription_id = ${oldDevice.id}`).length === 0,
    `${route}: account switch removes the previous device and its queued deliveries`);
    check((await sql`SELECT 1 FROM push_subscriptions WHERE id = ${otherDevice.id}`).length === 1
      && (await call<{ user: { id: number } }>({ ...previous, cookie: `sw_session=${otherToken}` }, "/api/me")).user.id === previous.id,
    `${route}: another device stays signed in and subscribed`);
  }
}

async function deviceCap() {
  const owner = await user("device_cap");
  const expiredToken = await createSession(owner.id);
  await sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token = ${expiredToken}`;
  const endpoint = `https://fcm.googleapis.com/fcm/send/cap-${suffix}`;
  await sql`INSERT INTO push_subscriptions(user_id,session_token,endpoint,p256dh,auth,vapid_key,label)
    SELECT ${owner.id}, ${expiredToken}, ${endpoint} || '-expired-' || i, ${p256dh}, ${auth}, 'fixture-only', 'Expired fixture'
    FROM generate_series(1,10) i`;
  const devices = async () => (await call<{ devices: { id: number }[] }>(owner, "/api/notification-settings")).devices;
  check((await devices()).length === 0, "Expired-session devices are hidden before cleanup");
  const body = { endpoint, p256dh, auth, publicKey: process.env.VAPID_PUBLIC_KEY, label: "Cap fixture" };
  await call(owner, "/api/push/subscriptions", body);
  check((await devices()).length === 1, "Ten expired subscriptions do not block a new visible device");
  await sql`INSERT INTO push_subscriptions(user_id,session_token,endpoint,p256dh,auth,vapid_key,label)
    SELECT ${owner.id}, ${owner.token}, ${endpoint} || '-active-' || i, ${p256dh}, ${auth}, 'fixture-only', 'Active fixture'
    FROM generate_series(1,8) i`;
  const attempts = await Promise.all([1, 2].map((i) => fetch(origin + "/api/push/subscriptions", {
    method: "POST", headers: { cookie: owner.cookie, "content-type": "application/json" },
    body: JSON.stringify({ ...body, endpoint: `${endpoint}-concurrent-${i}` }),
  })));
  check(attempts.map((r) => r.status).sort().join(",") === "200,409" && (await devices()).length === 10,
    "Concurrent enrollments cannot exceed ten active devices");
  await call(owner, "/api/push/subscriptions", body);
  check((await devices()).length === 10, "An active device can refresh its subscription at the cap");
  await call(owner, "/api/push/subscriptions", { ...body, endpoint: `${endpoint}-expired-1` }, "POST", 409);
  receipts.push("An expired endpoint cannot bypass the active-device cap");
}

async function groupBalanceNotifications() {
  const actor = await user("balance_actor"), reader = await user("balance_reader");
  const observer = await user("balance_observer"), outside = await user("balance_outside");
  const group = await call<{ id: number; inviteCode: string }>(actor, "/api/groups", { name: "Balance notification fixture", currency: "USD" });
  for (const member of [reader, observer]) await call(member, "/api/groups/join", { code: group.inviteCode });
  const path = `/api/groups/${group.id}/group-balances`;
  async function balances() {
    const result = await call<{ balances: { userId: number; netCents: number }[] }>(actor, `/api/groups/${group.id}`);
    return result.balances.map((r) => [r.userId, r.netCents]).sort((a, b) => a[0] - b[0]);
  }
  const body = { clientRequestId: randomUUID(), title: "Private group balance fixture", amountCents: 100,
    owes: { method: "exact", participants: [{ userId: actor.id, value: 50 }, { userId: reader.id, value: 50 }] },
    receives: { method: "exact", participants: [{ userId: actor.id, value: 100 }, { userId: reader.id, value: 0 }] },
    expectedBalances: await balances() };
  await sql`INSERT INTO push_subscriptions(user_id,session_token,endpoint,p256dh,auth,vapid_key,label)
    VALUES (${reader.id},${reader.token},${`https://fcm.googleapis.com/fcm/send/balance-${suffix}`},
      ${p256dh},${auth},'fixture-only','Group balance fixture')`;
  async function notice(type: string, title: string, work: () => Promise<unknown>, queued: boolean) {
    const id = await event(type, reader, work, actor);
    const rows = await sql`SELECT * FROM notifications WHERE group_id = ${group.id} AND type = ${type}`;
    check(rows.length === 2 && rows.some((n) => Number(n.user_id) === observer.id), `${type}: every other member, including nonparticipants`);
    check(rows.every((n) => n.category === 'settlements' && n.title === title && n.href === `/groups/${group.id}?tab=balances`),
      `${type}: payment preference, exact title, and balances destination`);
    check((await sql`SELECT 1 FROM notification_deliveries WHERE notification_id = ${id}`).length === (queued ? 1 : 0),
      `${type}: category mute controls push while inbox remains`);
    await call(outside, `/api/notifications/${id}`, undefined, "GET", 404);
    return id;
  }
  let balanceId = 0;
  const added = await notice("group_balance.added", "Group balance added", async () => {
    const replies = await Promise.all([call<{ id: number }>(actor, path, body), call<{ id: number }>(actor, path, body)]);
    check(replies[0].id === replies[1].id, "Concurrent group balance create retries retain one record");
    balanceId = replies[0].id;
  }, true);
  check((await balances()).find(([id]) => id === reader.id)?.[1] === -50, "Group balance allocation still changes the expected net");
  const detailPath = `/api/group-balances/${balanceId}`;
  const detail = () => call<{ balance: { updatedAt: string } }>(actor, detailPath);
  const version = (await detail()).balance.updatedAt;
  let before = await lastId();
  check((await call<{ id: number }>(actor, path, body)).id === balanceId, "Sequential group balance retry retains the record");
  await call(actor, path, { ...body, title: "Conflicting intent" }, "POST", 400);
  await call(actor, path, { ...body, clientRequestId: randomUUID() }, "POST", 400);
  await call(outside, path, body, "POST", 403);
  check(await lastId() === before, "Group balance retries and rejected stale/unauthorized creates emit no duplicate notifications");
  const edit = { ...body, title: "Private group balance revised", expectedUpdatedAt: version, expectedBalances: await balances(),
    owes: { method: "exact", participants: [{ userId: actor.id, value: 100 }, { userId: reader.id, value: 0 }] } };
  await call(reader, "/api/notification-settings", { categories: { settlements: false } }, "PATCH");
  await notice("group_balance.edited", "Group balance changed", () => call(actor, detailPath, edit, "PATCH"), false);
  check((await balances()).every(([, net]) => net === 0), "Group balance edit retains zero-net allocation semantics");
  before = await lastId();
  await call(actor, detailPath, edit, "PATCH", 400);
  await call(actor, `${detailPath}?expectedUpdatedAt=${encodeURIComponent(version)}`, undefined, "DELETE", 400);
  await call(actor, `/api/groups/${group.id}/members/${reader.id}`, undefined, "DELETE", 400);
  check(await lastId() === before, "Stale group balance edits/deletes and zero-allocation member removal emit no alert");
  let rolledBack = false;
  try {
    await sql.transaction((tx) => [tx`INSERT INTO activity(group_id,actor_id,type,summary,data)
      VALUES (${group.id},${actor.id},'group_balance.added','Rolled-back fixture','{}')`, tx`SELECT 1/0`]);
  } catch { rolledBack = true; }
  check(rolledBack && await lastId() === before, "Group balance transaction failure rolls back notifications and outbox");
  await call(reader, "/api/notification-settings", { categories: { settlements: true } }, "PATCH");
  const latest = (await detail()).balance.updatedAt;
  await notice("group_balance.deleted", "Group balance deleted", () =>
    call(actor, `${detailPath}?expectedUpdatedAt=${encodeURIComponent(latest)}`, undefined, "DELETE"), true);
  before = await lastId();
  await call(actor, path, body, "POST", 400);
  check(await lastId() === before, "Create retry after group balance deletion does not resurrect a record or notice");
  const observerNotice = (await sql`SELECT id FROM notifications WHERE group_id = ${group.id} AND user_id = ${observer.id}
    AND type = 'group_balance.added'`)[0];
  await call(actor, `/api/groups/${group.id}/members/${observer.id}`, undefined, "DELETE");
  await call(observer, `/api/notifications/${observerNotice.id}`, undefined, "GET", 404);
  check((await call<{ notification: { href: string } }>(reader, `/api/notifications/${added}`)).notification.href === `/groups/${group.id}?tab=balances`,
    "Deleted group balance keeps the balances destination for remaining members");
  receipts.push("Group balance notifications retain current-membership access rules");
}

async function run() {
  if (process.argv.includes("--probe-account-switch")) return accountSwitches();
  if (process.argv.includes("--probe-device-cap")) return deviceCap();
  if (process.argv.includes("--probe-group-balances")) return groupBalanceNotifications();
  await accountSwitches();
  await deviceCap();
  await groupBalanceNotifications();
  for (const path of ["/api/notifications", "/api/notification-settings", "/api/notifications/1"]) {
    await call(null, path, undefined, "GET", 401); receipts.push(`${path}: authentication required`);
  }
  await call(null, "/api/notifications/deliver", {}, "POST", 401); receipts.push("Delivery scheduler rejects missing secret");
  const cronSecret = process.env.PUSH_CRON_SECRET;
  if (!cronSecret || cronSecret.length < 32) throw new Error("Supply the fixture server's scheduler secret");
  const scheduler = (credential: string) => fetch(origin + "/api/notifications/deliver", {
    method: "POST", headers: { authorization: `Bearer ${credential}` },
  });
  check((await scheduler(cronSecret)).status === 200, "Delivery scheduler accepts the configured fixture credential");
  check((await scheduler("é".repeat(cronSecret.length))).status === 401, "Malformed non-ASCII scheduler credentials are rejected without a server error");
  const alice = await user("Alice"); const bob = await user("Bob"); const outsider = await user("Outside");
  const me = await call<{ user: { id: number } }>(bob, "/api/me"); check(me.user.id === bob.id, "Fixture identity verified through live API");
  const expired = await sql`INSERT INTO notifications(user_id,event_key,category,type,title,body,href,created_at)
    VALUES (${bob.id}, ${`expired:${suffix}`}, 'test','test','Expired fixture','Fixture only','/notifications',now() - interval '91 days') RETURNING id`;
  await call(bob, `/api/notifications/${expired[0].id}`, undefined, "GET", 404);
  const expiredInbox = await call<{ notifications: { id: number }[]; unreadCount: number }>(bob, "/api/notifications");
  check(expiredInbox.notifications.length === 0 && expiredInbox.unreadCount === 0, "Expired inbox entries are hidden even before scheduled cleanup");
  const beforeGroup = await lastId();
  const group = await call<{ id: number; inviteCode: string }>(alice, "/api/groups", { name: "Notification Test Trip", currency: "USD" });
  check(await lastId() === beforeGroup, "Creating a group alone emits no alert");
  await event("group.joined", alice, () => call(bob, "/api/groups/join", { code: group.inviteCode }), bob);
  await event("group.renamed", bob, () => call(alice, `/api/groups/${group.id}`, { name: "Notification Test Weekend" }, "PATCH"), alice);
  const groupMessage = () => call(alice, `/api/groups/${group.id}/messages`, { body: "Private fixture message: do not put this text on the lock screen" });
  await event("message.group", bob, groupMessage, alice);
  if (process.argv.includes("--probe-message")) return;
  await event("message.dm", bob, () => call(alice, `/api/dm/${bob.id}/messages`, { body: "Direct fixture message" }), alice);
  for (const [scope, type] of [[`msg:group:${group.id}`, "message.group"], [`msg:dm:${alice.id}`, "message.dm"]]) {
    const message = (await sql`SELECT MAX(id) AS id FROM messages WHERE sender_id = ${alice.id}`)[0];
    await call(bob, "/api/read", { scope, lastId: Number(message.id) });
    check((await sql`SELECT 1 FROM notifications WHERE user_id = ${bob.id} AND type = ${type} AND read_at IS NULL`).length === 0,
      `${type}: opening chat marks matching notifications read`);
  }
  let expenseId = 0;
  const expense = { title: "Fixture dinner", amountCents: 2400, currency: "USD", date: "2026-10-01", payerId: alice.id,
    splitMethod: "equal", participants: [{ userId: alice.id }, { userId: bob.id }], notes: "Private fixture note" };
  const addedId = await event("expense.added", bob, async () => {
    expenseId = (await call<{ id: number }>(alice, `/api/groups/${group.id}/expenses`, expense)).id;
  }, alice);
  const version = (await currentExpense(alice, expenseId)).updatedAt;
  await event("expense.edited", bob, () => call(alice, `/api/expenses/${expenseId}`,
    { ...expense, title: "Fixture dinner changed", expectedUpdatedAt: version }, "PATCH"), alice);
  const beforeStale = await lastId();
  await call(alice, `/api/expenses/${expenseId}`, { ...expense, expectedUpdatedAt: version }, "PATCH", 400);
  check(await lastId() === beforeStale, "Rejected stale expense edit emits no notification");
  await event("expense.comment", alice, () => call(bob, `/api/expenses/${expenseId}/comments`, { body: "Fixture expense question" }), bob);
  let receiptId = 0;
  await event("expense.receipt_added", bob, async () => {
    const form = new FormData();
    form.append("file", new Blob([readFileSync("public/icon-192.png")], { type: "image/png" }), "fixture.png");
    const r = await fetch(origin + `/api/expenses/${expenseId}/attachments`, { method: "POST", headers: { cookie: alice.cookie }, body: form });
    check(r.ok, "Receipt upload succeeds"); receiptId = (await r.json()).id;
  }, alice);
  await event("expense.receipt_removed", bob, () => call(alice, `/api/attachments/${receiptId}`, undefined, "DELETE"), alice);
  const rule = { title: "Fixture recurring", amountCents: 1000, currency: "USD", payerId: alice.id,
    participantIds: [alice.id, bob.id], cadence: "monthly", startDate: "2099-01-01", notes: "" };
  let recurringId = 0;
  await event("recurring.created", bob, async () => { recurringId = (await call<{ id: number }>(alice, `/api/groups/${group.id}/recurring`, rule)).id; }, alice);
  const rules = await call<{ recurring: { id: number; updatedAt: string }[] }>(alice, `/api/groups/${group.id}/recurring`);
  let recurringVersion = rules.recurring.find((r) => r.id === recurringId)!.updatedAt;
  await event("recurring.updated", bob, async () => {
    recurringVersion = (await call<{ updatedAt: string }>(alice, `/api/recurring/${recurringId}`,
      { ...rule, title: "Fixture monthly rent", nextDate: "2099-02-01", active: true, expectedUpdatedAt: recurringVersion }, "PATCH")).updatedAt;
  }, alice);
  await event("recurring.stopped", bob, () => call(alice, `/api/recurring/${recurringId}?expectedUpdatedAt=${encodeURIComponent(recurringVersion)}`, undefined, "DELETE"), alice);
  const today = String((await sql`SELECT CURRENT_DATE::text AS date`)[0].date);
  const dueRule = await call<{ id: number }>(alice, `/api/groups/${group.id}/recurring`, { ...rule, startDate: today });
  await event("expense.recurring", bob, () => call(alice, `/api/groups/${group.id}/expenses`));
  check((await sql`SELECT 1 FROM notifications WHERE user_id = ${alice.id} AND type = 'expense.recurring'`).length === 1, "Automatic recurring expense also notifies its owner");
  const afterMaterialize = await lastId(); await call(alice, `/api/groups/${group.id}/expenses`);
  check(await lastId() === afterMaterialize, "Repeated materialization produces no duplicate notification");
  await sql`UPDATE recurring_expenses SET participant_ids = ARRAY[${outsider.id}]::bigint[], next_date = CURRENT_DATE WHERE id = ${dueRule.id}`;
  await event("recurring.paused", bob, () => call(alice, `/api/groups/${group.id}/expenses`));
  const formerOwnerRule = await call<{ id: number }>(alice, `/api/groups/${group.id}/recurring`, { ...rule, startDate: today });
  await sql`UPDATE recurring_expenses SET created_by = ${outsider.id} WHERE id = ${formerOwnerRule.id}`;
  await event("expense.recurring", bob, () => call(alice, `/api/groups/${group.id}/expenses`));
  receipts.push("Valid recurring expense still materializes after its creator leaves");
  for (const scoped of [true, false]) {
    let settlement = { id: 0, updatedAt: "" };
    const body = { payerId: alice.id, recipientId: bob.id, amountCents: 100, currency: "USD", date: today, note: "Fixture payment" };
    await event("settlement.recorded", bob, async () => {
      settlement = await call(alice, scoped ? `/api/groups/${group.id}/settlements` : "/api/settlements", scoped ? body : { ...body, friendId: bob.id, direction: "i-paid" });
    }, alice);
    await event("settlement.updated", bob, async () => {
      const r = await call<{ updatedAt: string }>(alice, `/api/settlements/${settlement.id}`, { ...body, note: "Changed fixture note", expectedUpdatedAt: settlement.updatedAt }, "PATCH");
      settlement.updatedAt = r.updatedAt;
    }, alice);
    await event("settlement.deleted", bob, () => call(alice, `/api/settlements/${settlement.id}?expectedUpdatedAt=${encodeURIComponent(settlement.updatedAt)}`, undefined, "DELETE"), alice);
    receipts.push(scoped ? "Group payment lifecycle" : "Direct payment lifecycle");
  }
  let nudgeId = 0;
  for (let i = 0; i < 2; i++) await event("nudge.received", bob, async () => {
    nudgeId = (await call<{ id: number }>(alice, "/api/nudges", { toId: bob.id, groupId: group.id, note: `Fixture reminder ${i}` })).id;
  }, alice);
  const beforeDismiss = await lastId(); await call(bob, `/api/nudges/${nudgeId}`, undefined, "DELETE");
  check(await lastId() === beforeDismiss, "Reminder dismissal emits no alert");
  const dismissed = await sql`SELECT read_at FROM notifications WHERE user_id = ${bob.id} AND event_key LIKE ${`nudge:${nudgeId}:%`}`;
  check(dismissed.length === 2 && dismissed.every((n) => n.read_at !== null), "Reminder dismissal marks all versions of its notification read");
  await event("nudge.received", bob, () => call(alice, "/api/nudges", { toId: bob.id, note: "Direct reminder" }), alice);
  check((await sql`SELECT 1 FROM notifications WHERE user_id = ${outsider.id}`).length === 0, "Unrelated account receives no group, money, message, or reminder event");
  for (const action of ["decline", "cancel", "accept"] as const) {
    const requestNotification = await event("friend.requested", outsider, () => call(alice, "/api/friends", { code: outsider.inviteCode }), alice);
    const request = (await sql`SELECT id FROM friend_requests WHERE from_id = ${alice.id} AND to_id = ${outsider.id}`)[0];
    const work = () => call(action === "cancel" ? alice : outsider, "/api/friends/requests", { requestId: Number(request.id), action });
    if (action === "accept") await event("friend.added", alice, work, outsider);
    else { const before = await lastId(); await work(); check(await lastId() === before, `Friend request ${action} is silent`); }
    check((await sql`SELECT read_at FROM notifications WHERE id = ${requestNotification}`)[0].read_at !== null,
      `Friend request ${action} marks its notification read`);
  }
  await event("friend.removed", outsider, () => call(alice, "/api/friends", { friendId: outsider.id }, "DELETE"), alice);
  const invitedName = `notif_invited_${suffix}`;
  await event("user.joined", bob, async () => {
    await call(null, "/api/auth/signup", { username: invitedName, displayName: "Notification Test Invited", password, inviteCode: bob.inviteCode });
    const id = Number((await sql`SELECT id FROM users WHERE username = ${invitedName}`)[0].id);
    users.push({ id, username: invitedName, cookie: "", token: "", inviteCode: "" });
  });
  const emptyGroup = await call<{ id: number; inviteCode: string }>(alice, "/api/groups", { name: "Notification membership fixture", currency: "USD" });
  await call(bob, "/api/groups/join", { code: emptyGroup.inviteCode }); await call(outsider, "/api/groups/join", { code: emptyGroup.inviteCode });
  await event("group.member_removed", outsider, () => call(alice, `/api/groups/${emptyGroup.id}/members/${outsider.id}`, undefined, "DELETE"), alice);
  await event("group.deleted", bob, () => call(alice, `/api/groups/${emptyGroup.id}`, undefined, "DELETE"), alice);
  const outsiderMe = (await call<{ notifications: { id: number }[] }>(outsider, "/api/notifications")).notifications;
  check(!outsiderMe.some((n) => n.id === addedId), "Inbox query isolates recipients");
  await call(outsider, `/api/notifications/${addedId}`, undefined, "GET", 404);
  await call(outsider, "/api/notifications", { id: addedId, read: true }, "PATCH");
  check((await sql`SELECT read_at FROM notifications WHERE id = ${addedId}`)[0].read_at === null, "Forged read ID cannot change another user's notification");
  await call(bob, "/api/notifications", { id: addedId, read: true }, "PATCH");
  check((await sql`SELECT read_at FROM notifications WHERE id = ${addedId}`)[0].read_at !== null, "Owner can mark read");
  await call(bob, "/api/notifications", { id: addedId, read: false }, "PATCH");
  check((await sql`SELECT read_at FROM notifications WHERE id = ${addedId}`)[0].read_at === null, "Owner can mark unread");
  const through = await lastId(); await groupMessage();
  await call(bob, "/api/notifications", { throughId: through, read: true }, "PATCH");
  const unseen = await call<{ notifications: { id: number }[] }>(bob, "/api/notifications?unread=1");
  check(unseen.notifications.length === 1 && unseen.notifications[0].id > through, "Mark all read preserves activity that arrives after the visible cursor");
  await call(bob, "/api/notification-settings", { categories: { strangers: true } }, "PATCH", 400);
  await call(bob, "/api/notification-settings", { categories: { messages: false } }, "PATCH");
  const bobPrefs = await call<{ preferences: { categories: { messages: boolean } } }>(bob, "/api/notification-settings");
  const alicePrefs = await call<{ preferences: { categories: { messages: boolean } } }>(alice, "/api/notification-settings");
  check(!bobPrefs.preferences.categories.messages && alicePrefs.preferences.categories.messages, "Preferences persist per account");
  const csrf = await fetch(origin + "/api/notification-settings", { method: "PATCH", headers: { cookie: bob.cookie, origin: "https://outside.invalid", "content-type": "application/json" }, body: '{"pushEnabled":false}' });
  check(csrf.status === 403, "Cross-origin preference write rejected");
  for (const endpoint of ["http://localhost/", "https://127.0.0.1/", "https://fcm.googleapis.com.evil.invalid/"]) {
    await call(bob, "/api/push/subscriptions", { endpoint, p256dh, auth, publicKey: process.env.VAPID_PUBLIC_KEY, label: "Invalid test" }, "POST", 400);
  }
  receipts.push("Subscription endpoint validation blocks SSRF targets");
  const endpoint = `https://fcm.googleapis.com/fcm/send/fixture-${suffix}`;
  const device = await call<{ id: number }>(bob, "/api/push/subscriptions", { endpoint, p256dh, auth, publicKey: process.env.VAPID_PUBLIC_KEY, label: "Fixture Chrome" });
  await call(outsider, "/api/push/subscriptions", { id: device.id }, "DELETE");
  check((await sql`SELECT 1 FROM push_subscriptions WHERE id = ${device.id}`).length === 1, "Device removal is owner scoped");
  check((await call<{ id: number | null }>(outsider, "/api/push/subscriptions/status", { endpoint })).id === null, "Device lookup does not reveal another owner's subscription");
  const settingsText = JSON.stringify(await call(bob, "/api/notification-settings"));
  check(!settingsText.includes(endpoint) && !settingsText.includes(auth) && !settingsText.includes(bob.token), "Settings never expose endpoint credentials or session tokens");
  await call(bob, "/api/push/subscriptions", { id: device.id }, "DELETE");
  let rolledBack = false;
  const beforeRollback = await lastId();
  try { await sql.transaction((tx) => [
    tx`INSERT INTO messages(channel, group_id, sender_id, body) VALUES ('group', ${group.id}, ${alice.id}, 'Rollback fixture')`,
    tx`SELECT 1 / 0`,
  ]); } catch { rolledBack = true; }
  check(rolledBack && await lastId() === beforeRollback, "Business rollback also rolls back notification and outbox writes");

  // Only the injected sender can use these keys. The running app has a different VAPID key.
  const fixtureKeys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = fixtureKeys.publicKey; process.env.VAPID_PRIVATE_KEY = fixtureKeys.privateKey;
  process.env.PUSH_ALLOWED_USER_IDS = String(bob.id);
  await call(bob, "/api/notification-settings", { pushEnabled: true, categories: { messages: true } }, "PATCH");
  const ids: number[] = [];
  for (let i = 0; i < 2; i++) {
    const rows = await sql`INSERT INTO push_subscriptions(user_id, session_token, endpoint, p256dh, auth, vapid_key, label)
      VALUES (${bob.id}, ${bob.token}, ${`${endpoint}-${i}`}, ${p256dh}, ${auth}, ${fixtureKeys.publicKey}, ${`Fixture ${i}`}) RETURNING id`;
    ids.push(Number(rows[0].id));
  }
  await groupMessage();
  const sent: string[] = [];
  let failSecond = true;
  const sender = async (sub: { endpoint: string }): Promise<PushResult> => {
    sent.push(sub.endpoint);
    return sub.endpoint.endsWith('-1') && failSecond ? { outcome: "retry", status: 503 } : { outcome: "sent", status: 201 };
  };
  const first = await deliverNotifications(sender);
  check(first.accepted === 1 && first.retried === 1, "Partial fanout records success and retries only failed device");
  await sql`UPDATE notification_deliveries SET next_attempt_at = now() WHERE subscription_id = ANY(${ids}) AND state = 'pending'`;
  failSecond = false; await deliverNotifications(sender);
  check(sent.filter((e) => e.endsWith('-0')).length === 1 && sent.filter((e) => e.endsWith('-1')).length === 2, "Retry does not resend an accepted device delivery");
  await groupMessage(); sent.length = 0;
  await Promise.all([deliverNotifications(sender), deliverNotifications(sender)]);
  check(sent.length === 2 && new Set(sent).size === 2, "Concurrent workers claim each device delivery once");
  await groupMessage();
  await sql`UPDATE notification_deliveries SET state = 'sending', lease_until = now() - interval '1 second'
    WHERE subscription_id = ANY(${ids}) AND state = 'pending'`;
  check((await deliverNotifications(sender)).accepted === 2, "Expired worker leases recover after process loss");
  await groupMessage();
  await call(bob, "/api/notification-settings", { categories: { messages: false } }, "PATCH");
  check((await deliverNotifications(sender)).skipped === 2, "Preference changes suppress already queued sends");
  await groupMessage();
  check((await sql`SELECT 1 FROM notification_deliveries WHERE subscription_id = ANY(${ids}) AND state = 'pending'`).length === 0, "Disabled categories still reach inbox but create no push jobs");
  await call(bob, "/api/notification-settings", { categories: { messages: true } }, "PATCH");
  await groupMessage(); const newest = await lastId(); await call(bob, "/api/notifications", { id: newest, read: true }, "PATCH");
  check((await deliverNotifications(sender)).skipped === 2, "Read notifications do not send late alerts");
  await groupMessage(); process.env.PUSH_ALLOWED_USER_IDS = ""; sent.length = 0;
  await deliverNotifications(sender); check(sent.length === 0, "Empty recipient allowlist prevents all delivery");
  process.env.PUSH_ALLOWED_USER_IDS = String(bob.id);
  const pendingId = await lastId();
  await sql`UPDATE notification_deliveries SET attempts = 7 WHERE notification_id = ${pendingId}`;
  check((await deliverNotifications(async () => ({ outcome: "retry", status: 503 }))).failed === 2, "Delivery stops after eight failed attempts");
  sent.length = 0; await deliverNotifications(sender); check(sent.length === 0, "Exhausted deliveries are not sent again");
  await groupMessage();
  await sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token = ${bob.token}`;
  check((await deliverNotifications(sender)).skipped === 2, "Expired sessions stop delivery");
  await sql`UPDATE sessions SET expires_at = now() + interval '30 days' WHERE token = ${bob.token}`;
  await groupMessage();
  check((await deliverNotifications(async () => ({ outcome: "gone", status: 410 }))).removed === 2, "Gone endpoints are removed without retrying");
  check((await sql`SELECT 1 FROM push_subscriptions WHERE id = ANY(${ids})`).length === 0, "Pruning reads back as removed devices");
  const extraToken = await createSession(bob.id);
  const extra = await sql`INSERT INTO push_subscriptions(user_id, session_token, endpoint, p256dh, auth, vapid_key, label)
    VALUES (${bob.id}, ${extraToken}, ${endpoint}, ${p256dh}, ${auth}, ${fixtureKeys.publicKey}, 'Fixture extra session') RETURNING id`;
  await call({ ...bob, cookie: `sw_session=${extraToken}` }, "/api/auth/logout", {}, "POST");
  check((await sql`SELECT 1 FROM push_subscriptions WHERE id = ${extra[0].id}`).length === 0, "Logout removes server subscription with the session");
  await event("expense.deleted", bob, async () => {
    const v = (await currentExpense(alice, expenseId)).updatedAt;
    await call(alice, `/api/expenses/${expenseId}?expectedUpdatedAt=${encodeURIComponent(v)}`, undefined, "DELETE");
  }, alice);
  const staleLink = await call<{ notification: { href: string } }>(bob, `/api/notifications/${addedId}`);
  check(staleLink.notification.href === `/groups/${group.id}?tab=activity`, "Deleted expense notification falls back to group activity");
  for (let i = 0; i < 55; i++) await sql`INSERT INTO notifications(user_id,event_key,category,type,title,body,href)
    VALUES (${bob.id}, ${`pagination:${suffix}:${i}`}, 'test','test','Pagination fixture','Fixture only','/notifications')`;
  const pageOne = await call<{ notifications: { id: number }[]; nextBefore: number | null }>(bob, "/api/notifications");
  check(pageOne.notifications.length > 0, "Inbox returns real fixture events");
  const pageTwo = await call<{ notifications: { id: number }[] }>(bob, `/api/notifications?before=${pageOne.nextBefore}`);
  check(pageOne.notifications.length === 50 && !!pageOne.nextBefore && pageTwo.notifications.every((n) => n.id < pageOne.nextBefore!), "Inbox pagination has no overlaps");
  await sql`DELETE FROM notifications WHERE user_id = ${bob.id} AND event_key LIKE ${`pagination:${suffix}:%`}`;
  const removedId = await event("message.group", outsider, async () => {
    await call(outsider, "/api/groups/join", { code: group.inviteCode }); await groupMessage();
  }, alice);
  await event("group.member_removed", bob, () => call(outsider, `/api/groups/${group.id}/members/${outsider.id}`, undefined, "DELETE"), outsider);
  await call(outsider, `/api/notifications/${removedId}`, undefined, "GET", 404);
  receipts.push("Leaving a group removes access to its earlier notifications");
  const ordinaryName = `notif_signup_${suffix}`;
  const beforeSignup = await lastId();
  await call(null, "/api/auth/signup", { username: ordinaryName, displayName: "Notification Test Signup", password });
  const ordinaryId = Number((await sql`SELECT id FROM users WHERE username = ${ordinaryName}`)[0].id);
  users.push({ id: ordinaryId, username: ordinaryName, cookie: "", token: "", inviteCode: "" });
  check(await lastId() === beforeSignup, "Ordinary signup emits no activity alert");
  const groupInviteName = `notif_group_${suffix}`;
  await event("group.joined", bob, async () => {
    await call(null, "/api/auth/signup", { username: groupInviteName, displayName: "Notification Test Group Signup", password, inviteCode: group.inviteCode });
    const id = Number((await sql`SELECT id FROM users WHERE username = ${groupInviteName}`)[0].id);
    users.push({ id, username: groupInviteName, cookie: "", token: "", inviteCode: "" });
    check((await sql`SELECT 1 FROM notifications WHERE user_id = ${id}`).length === 0, "Group-invite signup creates no self or duplicate friendship alert");
  });
  if (process.argv.includes("--keep")) {
    writeFileSync(".vercel/local-notification-fixture.json", JSON.stringify({ origin, username: bob.username, password, userId: bob.id, actorUsername: alice.username, groupId: group.id }), { mode: 0o600 });
  }
}

async function cleanup() {
  if (process.argv.includes("--keep")) return;
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await sql`DELETE FROM groups WHERE created_by = ANY(${ids})`;
  await sql`DELETE FROM activity WHERE actor_id = ANY(${ids})`;
  await sql`DELETE FROM settlements WHERE created_by = ANY(${ids})`;
  await sql`DELETE FROM messages WHERE sender_id = ANY(${ids})`;
  await sql`DELETE FROM users WHERE id = ANY(${ids})`;
}
run().then(() => console.log(JSON.stringify({ passed: receipts.length, checks: receipts }, null, 2)))
  .catch((e) => { console.error(JSON.stringify({ passed: receipts.length, failed: e instanceof Error ? e.message : "Fixture check failed", checks: receipts }, null, 2)); process.exitCode = 1; })
  .finally(cleanup);
