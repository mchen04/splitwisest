import "../src/lib/neon-local";
import { neon } from "@neondatabase/serverless";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";

const baseUrl = process.env.SPLITWISEST_BASE_URL ?? "http://127.0.0.1:3392";
const databaseUrl = process.env.DATABASE_URL ?? "";
const databaseName = (() => {
  try { return new URL(databaseUrl).pathname.replace(/^\//, ""); } catch { return ""; }
})();
assert(databaseName === "splitwisest_units_qa", "Use the dedicated splitwisest_units_qa database");
assert(baseUrl === "http://127.0.0.1:3392" || baseUrl === "http://localhost:3392", "Use the app on port 3392");
assert(process.env.NEON_LOCAL_PROXY, "NEON_LOCAL_PROXY is required");

const sql = neon(databaseUrl);
const password = process.env.SPLITWISEST_UNITS_QA_PASSWORD ?? randomBytes(32).toString("hex");
const suffix = randomBytes(4).toString("hex");
const failures: string[] = [];
let passed = 0;
let today = "";

type User = { id: number; cookie: string; name: string };
type Group = { id: number; currency: string; name: string };
type Body = Record<string, unknown>;
const users: User[] = [];
const groups: Group[] = [];
const byId = (rows: [number, number][]) => [...rows].sort((a, b) => a[0] - b[0]);
const byTriple = (rows: [number, number, number][]) => [...rows].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

function check(name: string, actual: unknown, expected: unknown) {
  try { assert.deepEqual(actual, expected); passed++; console.log(`PASS ${name}`); }
  catch { failures.push(name); console.error(`FAIL ${name}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`); }
}

async function request(path: string, user?: User, body?: Body, method = body ? "POST" : "GET") {
  const res = await fetch(new URL(path, baseUrl), {
    method,
    headers: { ...(user ? { cookie: user.cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return {
    status: res.status, text,
    data: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null,
    cookie: res.headers.get("set-cookie")?.split(";")[0],
  };
}

async function api(path: string, user?: User, body?: Body, method?: string) {
  const r = await request(path, user, body, method);
  assert.equal(r.status, 200, `${path}: ${r.status} ${r.text}`);
  return r.data;
}

async function signup(role: string) {
  const username = `units_${role}_${suffix}`;
  const r = await request("/api/auth/signup", undefined, {
    username, displayName: `Units ${role} ${suffix}`, password,
  });
  assert.equal(r.status, 200, r.text);
  const cookie = r.cookie;
  assert(cookie, "signup cookie missing");
  const me = await api("/api/me", { id: 0, cookie, name: "" });
  const user = { id: Number(me.user.id), cookie, name: String(me.user.displayName) };
  users.push(user);
  return user;
}

async function createGroup(owner: User, currency = "USD", label = "A") {
  const name = `Units QA ${label} ${suffix}`;
  const g = await api("/api/groups", owner, { name, currency });
  const group = { id: Number(g.id), currency, name };
  groups.push(group);
  return group;
}

async function join(group: Group, user: User, owner: User) {
  const invite = (await api(`/api/groups/${group.id}`, owner)).group.inviteCode;
  await api("/api/groups/join", user, { code: invite });
}

function expenseBody(group: Group, unitId: number | null, extra: Body = {}): Body {
  return {
    title: "Unit expense", amountCents: 100, currency: group.currency, unitId,
    date: today, payerId: users[0].id, notes: "", splitMethod: "equal",
    participants: users.slice(0, 3).map((u) => ({ userId: u.id })), ...extra,
  };
}

async function unitExpense(group: Group, unitId: number, extra: Body = {}) {
  const r = await api(`/api/groups/${group.id}/expenses`, users[0], expenseBody(group, unitId, extra));
  return Number(r.id);
}

async function expenseDetail(id: number) {
  return (await api(`/api/expenses/${id}`, users[0])).expense;
}

async function createUnit(group: Group, user: User, name: string) {
  return api(`/api/groups/${group.id}/units`, user, { name });
}

async function xact() {
  const rows = await sql`SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()`;
  return Number(rows[0].xact_commit);
}

async function queryDelta(fn: () => Promise<unknown>) {
  const before = await xact();
  await fn();
  const after = await xact();
  return after - before - 1;
}

async function moneySnapshot(group: Group) {
  const detail = await api(`/api/groups/${group.id}`, users[0]);
  return JSON.stringify({
    balances: detail.balances,
    suggestions: detail.suggestions,
    sql: (await sql`SELECT user_id, net_cents FROM group_balance_rows(${group.id}) ORDER BY user_id`)
      .map((r) => [Number(r.user_id), Number(r.net_cents)]),
  });
}

async function main() {
  today = (await sql`SELECT CURRENT_DATE::text AS day`)[0].day as string;
  const existing = Number((await sql`SELECT count(*) FROM users WHERE username LIKE ${`units\\_%\\_${suffix}`} ESCAPE '\\'`)[0].count);
  assert.equal(existing, 0, "fixture suffix collision");
  const [owner, b, c, d] = await Promise.all(["a", "b", "c", "d"].map(signup));
  users.length = 0;
  users.push(owner, b, c, d);
  const g1 = await createGroup(owner, "USD", "G1");
  const g2 = await createGroup(owner, "USD", "G2");
  await Promise.all([join(g1, b, owner), join(g1, c, owner), join(g1, d, owner), join(g2, b, owner)]);

  const moneyBefore = await moneySnapshot(g1);
  const moneyExpensesBefore = (await api(`/api/groups/${g1.id}/expenses?all=1`, owner)).expenses
    .filter((e: { unitId: number | null }) => e.unitId === null)
    .reduce((s: number, e: { convertedCents: number }) => s + e.convertedCents, 0);

  check("new group defaults to simplifying unit balances", (await api(`/api/groups/${g1.id}`, owner)).group.autoReconcileUnits, true);

  const drinks = await createUnit(g1, owner, "drinks");
  check("create unit keeps its trimmed name", drinks.name, "drinks");
  check("list units includes the new unit", (await api(`/api/groups/${g1.id}/units`, owner)).units.map((u: { name: string }) => u.name), ["drinks"]);
  check("rename unit", (await api(`/api/groups/${g1.id}/units/${drinks.id}`, owner, { name: "drink tickets" }, "PATCH")).name, "drink tickets");
  const temporary = await createUnit(g1, owner, "temporary");
  check("delete an unused unit", (await request(`/api/groups/${g1.id}/units/${temporary.id}`, owner, undefined, "DELETE")).status, 200);

  const duplicate = await createUnit(g1, owner, "  DRINK TICKETS  ");
  check("duplicate names converge in one group", duplicate.id, drinks.id);
  const otherGroupUnit = await createUnit(g2, owner, "drinks");
  check("the same label in another group is a different unit", otherGroupUnit.id !== drinks.id, true);

  const concurrent = await Promise.all(Array.from({ length: 6 }, () => createUnit(g1, owner, "points")));
  check("concurrent duplicate creates converge", new Set(concurrent.map((u: { id: number }) => u.id)).size, 1);
  check("concurrent duplicate creates leave one row", Number((await sql`SELECT count(*) FROM group_units WHERE group_id = ${g1.id} AND lower(btrim(name)) = 'points'`)[0].count), 1);

  const splitCases: { method: string; amountCents: number; extra: Body; expected: [number, number][] }[] = [
    { method: "equal", amountCents: 100, extra: {}, expected: byId([[owner.id, 34], [b.id, 33], [c.id, 33]]) },
    { method: "exact", amountCents: 100, extra: { participants: [
      { userId: owner.id, value: 34 }, { userId: b.id, value: 33 }, { userId: c.id, value: 33 }] }, expected: byId([[owner.id, 34], [b.id, 33], [c.id, 33]]) },
    { method: "percentage", amountCents: 100, extra: { participants: [
      { userId: owner.id, value: 33.33 }, { userId: b.id, value: 33.33 }, { userId: c.id, value: 33.34 }] }, expected: byId([[owner.id, 33], [b.id, 33], [c.id, 34]]) },
    { method: "shares", amountCents: 100, extra: { participants: [
      { userId: owner.id, value: 1 }, { userId: b.id, value: 1 }, { userId: c.id, value: 1 }] }, expected: byId([[owner.id, 34], [b.id, 33], [c.id, 33]]) },
    { method: "itemized", amountCents: 100, extra: { participants: users.slice(0, 3).map((u) => ({ userId: u.id })),
      items: [{ name: "round", amountCents: 100, participantIds: [owner.id, b.id, c.id] }] }, expected: byId([[owner.id, 34], [b.id, 33], [c.id, 33]]) },
  ];
  for (const split of splitCases) {
    const id = await unitExpense(g1, drinks.id, {
      title: `Unit ${split.method}`, amountCents: split.amountCents, splitMethod: split.method, ...split.extra,
    });
    const saved = await expenseDetail(id);
    check(`unit ${split.method} shares sum to the total`, saved.shares.reduce((s: number, row: { shareCents: number }) => s + row.shareCents, 0), split.amountCents);
    check(`unit ${split.method} exact hundredths`, saved.shares.map((s: { userId: number; shareCents: number }) => [s.userId, s.shareCents]).sort((a: number[], b: number[]) => a[0] - b[0]), split.expected);
    check(`unit ${split.method} keeps its unit`, [saved.unitId, saved.unitName, saved.currency, saved.convertedCents], [drinks.id, "drink tickets", g1.currency, split.amountCents]);
  }

  const beforeRejected = Number((await sql`SELECT count(*) FROM expenses WHERE group_id = ${g1.id}`)[0].count);
  const forged = await request(`/api/groups/${g1.id}/expenses`, owner, expenseBody(g1, otherGroupUnit.id, { title: "Forged" }));
  check("a unit from another group is rejected", forged.status, 400);
  check("a rejected forged expense writes nothing", Number((await sql`SELECT count(*) FROM expenses WHERE group_id = ${g1.id}`)[0].count), beforeRejected);
  check("a malformed amount is rejected", (await request(`/api/groups/${g1.id}/expenses`, owner, expenseBody(g1, drinks.id, { amountCents: 0 }))).status, 400);
  check("an empty unit name is rejected", (await request(`/api/groups/${g1.id}/units`, owner, { name: "   " })).status, 400);

  const onUnit = await createUnit(g1, owner, "on");
  await unitExpense(g1, onUnit.id, { title: "On mode", amountCents: 300, participants: users.slice(0, 3).map((u) => ({ userId: u.id })) });
  let detail = await api(`/api/groups/${g1.id}`, owner);
  let unit = detail.unitBalances.find((row: { name: string }) => row.name === "on");
  check("ON mode keeps unit nets", unit.nets.filter((row: { netCents: number }) => row.netCents !== 0).map((row: { userId: number; netCents: number }) => [row.userId, row.netCents]).sort((a: number[], b: number[]) => a[0] - b[0]), byId([[owner.id, 200], [b.id, -100], [c.id, -100]]));
  check("ON mode simplifies to two payments", unit.transfers.length, 2);
  check("ON mode exposes no directed obligations", unit.obligations, []);

  const offUnit = await createUnit(g1, owner, "off");
  await unitExpense(g1, offUnit.id, { title: "Off A", amountCents: 300, participants: users.slice(0, 3).map((u) => ({ userId: u.id })) });
  await unitExpense(g1, offUnit.id, { title: "Off B", amountCents: 200, payerId: b.id, participants: [owner, b].map((u) => ({ userId: u.id })) });
  await api(`/api/groups/${g1.id}`, owner, { autoReconcileUnits: false }, "PATCH");
  detail = await api(`/api/groups/${g1.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "off");
  check("OFF setting persists", detail.group.autoReconcileUnits, false);
  check("OFF mode keeps both directions", byTriple(unit.obligations.map((row: { from: number; to: number; amountCents: number }) => [row.from, row.to, row.amountCents])), byTriple([
    [owner.id, b.id, 100], [b.id, owner.id, 100], [c.id, owner.id, 100],
  ]));

  const offRepayment = await api(`/api/groups/${g1.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 100, currency: g1.currency, unitId: offUnit.id, date: today, note: "repay",
  });
  detail = await api(`/api/groups/${g1.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "off");
  check("OFF repayment removes only that direct debt", byTriple(unit.obligations.map((row: { from: number; to: number; amountCents: number }) => [row.from, row.to, row.amountCents])), byTriple([
    [owner.id, b.id, 100], [c.id, owner.id, 100],
  ]));
  const beforeOverpay = Number((await sql`SELECT count(*) FROM settlements WHERE group_id = ${g1.id}`)[0].count);
  check("OFF over-repayment is rejected", (await request(`/api/groups/${g1.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 101, currency: g1.currency, unitId: offUnit.id, date: today, note: "too much",
  })).status, 400);
  check("OFF over-repayment writes nothing", Number((await sql`SELECT count(*) FROM settlements WHERE group_id = ${g1.id}`)[0].count), beforeOverpay);
  await api(`/api/settlements/${offRepayment.id}?expectedUpdatedAt=${encodeURIComponent(offRepayment.updatedAt)}`, b, undefined, "DELETE");

  const toggle = await request(`/api/groups/${g1.id}`, owner, { autoReconcileUnits: true }, "PATCH");
  check("toggle back ON", [toggle.status, (await api(`/api/groups/${g1.id}`, owner)).group.autoReconcileUnits], [200, true]);
  await api(`/api/groups/${g1.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 100, currency: g1.currency, unitId: onUnit.id, date: today, note: "on repay",
  });
  detail = await api(`/api/groups/${g1.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "on");
  check("ON repayment nets against the unit", unit.nets.filter((row: { netCents: number }) => row.netCents !== 0).map((row: { userId: number; netCents: number }) => [row.userId, row.netCents]).sort((a: number[], b: number[]) => a[0] - b[0]), byId([[owner.id, 100], [c.id, -100]]));

  await api(`/api/groups/${g1.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 500, currency: g1.currency, unitId: onUnit.id, date: today, note: "historic excess",
  });
  await api(`/api/groups/${g1.id}`, owner, { autoReconcileUnits: false }, "PATCH");
  detail = await api(`/api/groups/${g1.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "on");
  check("historic excess shows as the reverse obligation", unit.obligations.some((row: { from: number; to: number; amountCents: number }) => row.from === owner.id && row.to === b.id && row.amountCents > 0), true);
  await api(`/api/groups/${g1.id}`, owner, { autoReconcileUnits: true }, "PATCH");

  const editId = await unitExpense(g1, drinks.id, { title: "Edit me", amountCents: 300 });
  const editBefore = await expenseDetail(editId);
  await api(`/api/expenses/${editId}`, owner, expenseBody(g1, drinks.id, {
    title: "Edited unit", amountCents: 400, expectedUpdatedAt: editBefore.updatedAt,
  }), "PATCH");
  const editAfter = await expenseDetail(editId);
  check("edit keeps the unit and denomination", [editAfter.title, editAfter.unitId, editAfter.unitName, editAfter.convertedCents], ["Edited unit", drinks.id, "drink tickets", 400]);
  await api(`/api/expenses/${editId}?expectedUpdatedAt=${encodeURIComponent(editAfter.updatedAt)}`, owner, undefined, "DELETE");
  check("delete a unit expense", Number((await sql`SELECT count(*) FROM expenses WHERE id = ${editId}`)[0].count), 0);

  const settlementId = (await api(`/api/groups/${g1.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 50, currency: g1.currency, unitId: drinks.id, date: today, note: "edit settlement",
  })).id;
  const settlementRow = (await api(`/api/groups/${g1.id}/settlements`, owner)).settlements.find((s: { id: number }) => s.id === settlementId);
  const settlementEdit = await api(`/api/settlements/${settlementId}`, b, {
    amountCents: 60, currency: g1.currency, unitId: drinks.id, date: today, note: "edited", expectedUpdatedAt: settlementRow.updatedAt,
  }, "PATCH");
  check("edit a unit settlement", Number((await sql`SELECT amount_cents FROM settlements WHERE id = ${settlementId}`)[0].amount_cents), 60);
  await api(`/api/settlements/${settlementId}?expectedUpdatedAt=${encodeURIComponent(settlementEdit.updatedAt)}`, b, undefined, "DELETE");
  check("delete a unit settlement", Number((await sql`SELECT count(*) FROM settlements WHERE id = ${settlementId}`)[0].count), 0);

  const moneyAfter = await moneySnapshot(g1);
  check("money balances are byte-identical after unit data", moneyAfter, moneyBefore);
  const allExpenses = (await api(`/api/groups/${g1.id}/expenses?all=1`, owner)).expenses;
  check("money insights exclude unit rows", allExpenses.filter((e: { unitId: number | null }) => e.unitId !== null).every((e: { convertedCents: number }) => e.convertedCents > 0), true);
  const moneySum = allExpenses.filter((e: { unitId: number | null }) => e.unitId === null).reduce((s: number, e: { convertedCents: number }) => s + e.convertedCents, 0);
  check("money total is unchanged by unit rows", moneySum, moneyExpensesBefore);

  const counts: [string, number, number][] = [];
  const overhead = await queryDelta(async () => {});
  const proxyTransactionsPerQuery = Math.max(1, (await queryDelta(async () => { await sql`SELECT 1`; })) - overhead);
  const measured = async (fn: () => Promise<unknown>) =>
    Math.round(((await queryDelta(fn)) - overhead) / proxyTransactionsPerQuery);
  counts.push(["/api/groups", await measured(() => api("/api/groups", owner)), 1]);
  counts.push(["/api/friends", await measured(() => api("/api/friends", owner)), 3]);
  counts.push(["/api/groups/:id", await measured(() => api(`/api/groups/${g1.id}`, owner)), 2]);
  counts.push(["/api/groups/:id/expenses", await measured(() => api(`/api/groups/${g1.id}/expenses?limit=10`, owner)), 2]);
  counts.push(["/api/expenses", await measured(() => api("/api/expenses?limit=10", owner)), 1]);
  counts.push(["/api/sync", await measured(() => api("/api/sync", owner)), 1]);
  for (const [label, actual, expected] of counts) check(`query count ${label}`, actual, expected);

  await cleanup();
  console.log(JSON.stringify({ passed, failed: failures.length, failures }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}

async function cleanup() {
  const ids = users.map((u) => u.id);
  const groupIds = groups.map((g) => g.id);
  if (groupIds.length > 0) await sql`DELETE FROM groups WHERE id = ANY(${groupIds})`;
  if (ids.length > 0) {
    await sql`DELETE FROM auth_rate_limits WHERE key LIKE ${`units\\_%\\_${suffix}`} ESCAPE '\\'`;
    await sql`DELETE FROM group_members WHERE user_id = ANY(${ids})`;
    await sql`DELETE FROM activity WHERE actor_id = ANY(${ids})`;
    await sql`DELETE FROM messages WHERE sender_id = ANY(${ids}) OR dm_a = ANY(${ids}) OR dm_b = ANY(${ids})`;
    await sql`DELETE FROM settlements WHERE payer_id = ANY(${ids}) OR recipient_id = ANY(${ids}) OR created_by = ANY(${ids})`;
    await sql`DELETE FROM nudges WHERE from_id = ANY(${ids}) OR to_id = ANY(${ids})`;
    await sql`DELETE FROM friend_requests WHERE from_id = ANY(${ids}) OR to_id = ANY(${ids})`;
    await sql`DELETE FROM friendships WHERE user_a = ANY(${ids}) OR user_b = ANY(${ids})`;
    await sql`DELETE FROM recovery_codes WHERE user_id = ANY(${ids})`;
    await sql`DELETE FROM users WHERE id = ANY(${ids})`;
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await cleanup().catch(() => {});
  process.exitCode = 1;
});
