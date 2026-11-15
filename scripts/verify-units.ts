import "../src/lib/neon-local";
import { neon } from "@neondatabase/serverless";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";

const baseUrl = process.env.SPLITWISEST_BASE_URL ?? "http://127.0.0.1:3392";
const databaseUrl = process.env.DATABASE_URL ?? "";
const databaseName = (() => {
  try { return new URL(databaseUrl).pathname.replace(/^\//, ""); } catch { return ""; }
})();
assert(["splitwisest_units_qa", "splitwisest_money_qa"].includes(databaseName), "Use a dedicated splitwisest_units_qa or splitwisest_money_qa database");
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname), "Use a loopback app");
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

function detailUnitSummary(detail: Body, viewerId: number) {
  return (detail.unitBalances as Body[])
    .map((unit) => {
      const net = (unit.nets as Body[]).find((row) => Number(row.userId) === viewerId)?.netCents ?? 0;
      const gross = (unit.gross as Body[]).find((row) => Number(row.userId) === viewerId) ?? { owesCents: 0, owedCents: 0 };
      return {
        unitId: Number(unit.unitId), name: unit.name, reconcile: unit.reconcile,
        netCents: Number(net), owesCents: Number(gross.owesCents), owedCents: Number(gross.owedCents),
      };
    })
    .filter((unit) => unit.reconcile
      ? unit.netCents !== 0
      : unit.owesCents !== 0 || unit.owedCents !== 0)
    .sort((a, b) => a.unitId - b.unitId);
}

function detailUnitFriendObligations(detail: Body, viewerId: number, friendId: number) {
  const rows: { unitId: number; unitName: string; netCents: number }[] = [];
  for (const unit of detail.unitBalances as Body[]) {
    const unitRows = (unit.reconcile ? unit.transfers : unit.obligations) as Body[];
    for (const row of unitRows) {
      if (Number(row.from) !== viewerId && Number(row.to) !== viewerId) continue;
      const other = Number(row.from) === viewerId ? Number(row.to) : Number(row.from);
      if (other !== friendId) continue;
      rows.push({
        unitId: Number(unit.unitId), unitName: String(unit.name),
        netCents: Number(row.to) === viewerId ? Number(row.amountCents) : -Number(row.amountCents),
      });
    }
  }
  return rows.sort((a, b) => a.unitId - b.unitId || a.netCents - b.netCents);
}

function friendUnitObligations(friend: Body, groupId: number) {
  return (friend.obligations as Body[])
    .filter((row) => row.kind === "unit" && Number(row.groupId) === groupId)
    .map((row) => ({ unitId: Number(row.unitId), unitName: String(row.unitName), netCents: Number(row.netCents) }))
    .sort((a, b) => a.unitId - b.unitId || a.netCents - b.netCents);
}

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
  const delta = after - before - 1;
  return delta;
}

async function moneySnapshot(group: Group) {
  const detail = await api(`/api/groups/${group.id}`, users[0]);
  const expenses = (await api(`/api/groups/${group.id}/expenses?all=1`, users[0])).expenses;
  const exportText = (await request(`/api/groups/${group.id}/export`, users[0])).text;
  const friends = await api("/api/friends", users[0]);
  const people = (await api(`/api/people/${users[1].id}`, users[0])).profile;
  const friend = friends.friends.find((row: { id: number }) => row.id === users[1].id);
  const groupRow = (await api("/api/groups", users[0])).groups.find((row: { id: number }) => row.id === group.id);
  return JSON.stringify({
    balances: detail.balances,
    suggestions: detail.suggestions,
    groupList: { id: groupRow?.id ?? null, myNetCents: groupRow?.myNetCents ?? null },
    sql: (await sql`SELECT user_id, net_cents FROM group_balance_rows(${group.id}) ORDER BY user_id`)
      .map((r) => [Number(r.user_id), Number(r.net_cents)]),
    insights: expenses.filter((e: { unitId: number | null }) => e.unitId === null)
      .map((e: { id: number; convertedCents: number }) => [e.id, e.convertedCents])
      .sort((a: number[], b: number[]) => a[0] - b[0]),
    insightsTotal: expenses.filter((e: { unitId: number | null }) => e.unitId === null)
      .reduce((sum: number, e: { convertedCents: number }) => sum + e.convertedCents, 0),
    exportMoney: csvMoneyTotal(exportText),
    friendMoney: {
      netByCurrency: friend?.netByCurrency ?? {},
      obligations: (friend?.obligations ?? []).filter((row: { kind?: string }) => row.kind !== "unit"),
    },
    peopleMoney: {
      netByCurrency: people.netByCurrency,
      obligations: people.obligations.filter((row: { kind?: string }) => row.kind !== "unit"),
    },
  });
}

function csvMoneyTotal(text: string) {
  const lines = text.trim().split("\n");
  const header = lines[0].split(",");
  const amountIndex = header.indexOf("Amount (USD)");
  const unitIndex = header.indexOf("Unit");
  assert(amountIndex >= 0 && unitIndex === header.length - 1, "CSV keeps money columns and appends Unit");
  let total = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (cells[unitIndex] === "") total += Math.round(Number(cells[amountIndex]) * 100);
  }
  return total;
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

  await sql`INSERT INTO friendships (user_a, user_b)
    VALUES (LEAST(${owner.id}::bigint, ${b.id}::bigint), GREATEST(${owner.id}::bigint, ${b.id}::bigint))
    ON CONFLICT DO NOTHING`;

  const moneyExpense = await api(`/api/groups/${g1.id}/expenses`, owner, {
    title: "Money baseline", amountCents: 1000, currency: g1.currency, unitId: null,
    date: today, payerId: owner.id, notes: "", splitMethod: "equal",
    participants: users.slice(0, 3).map((u) => ({ userId: u.id })),
  });
  await api(`/api/groups/${g1.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 100, currency: g1.currency, unitId: null,
    date: today, note: "money baseline",
  });
  const moneyBefore = await moneySnapshot(g1);
  const moneyExpensesBefore = JSON.parse(moneyBefore).insightsTotal as number;
  check("money baseline has a real expense", Number(moneyExpense.id) > 0, true);

  check("new group defaults to simplifying unit balances", (await api(`/api/groups/${g1.id}`, owner)).group.autoReconcileUnits, true);

  const drinks = await createUnit(g1, owner, "drinks");
  check("create unit keeps its trimmed name", drinks.name, "drinks");
  check("group detail lists the new unit", (await api(`/api/groups/${g1.id}`, owner)).units.map((u: { name: string }) => u.name), ["drinks"]);
  check("rename unit", (await api(`/api/groups/${g1.id}/units/${drinks.id}`, owner, { name: "drink tickets" }, "PATCH")).name, "drink tickets");
  const temporary = await createUnit(g1, owner, "temporary");
  check("delete an unused unit", (await request(`/api/groups/${g1.id}/units/${temporary.id}`, owner, undefined, "DELETE")).status, 200);

  const duplicate = await createUnit(g1, owner, "  DRINK TICKETS  ");
  check("duplicate names converge in one group", duplicate.id, drinks.id);
  const addedBefore = Number((await sql`SELECT count(*) FROM activity WHERE group_id = ${g1.id} AND type = 'group_unit.added'`)[0].count);
  await createUnit(g1, owner, "drink tickets");
  const addedAfter = Number((await sql`SELECT count(*) FROM activity WHERE group_id = ${g1.id} AND type = 'group_unit.added'`)[0].count);
  check("re-adding a unit does not log an add", addedAfter, addedBefore);
  const otherGroupUnit = await createUnit(g2, owner, "drinks");
  check("the same label in another group is a different unit", otherGroupUnit.id !== drinks.id, true);

  const concurrent = await Promise.all(Array.from({ length: 6 }, () => createUnit(g1, owner, "points")));
  check("concurrent duplicate creates converge", new Set(concurrent.map((u: { id: number }) => u.id)).size, 1);
  check("concurrent duplicate creates leave one row", Number((await sql`SELECT count(*) FROM group_units WHERE group_id = ${g1.id} AND lower(btrim(name)) = 'points'`)[0].count), 1);
  const concurrentRace = await Promise.all(Array.from({ length: 8 }, () => createUnit(g1, owner, "race-unit")));
  check("concurrent identical creates return the same row", new Set(concurrentRace.map((u: { id: number }) => u.id)).size, 1);
  check("concurrent identical creates log one add", Number((await sql`
    SELECT count(*) FROM activity
    WHERE group_id = ${g1.id} AND type = 'group_unit.added'
      AND summary LIKE '%added the unit race-unit'`)[0].count), 1);

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

  const jpyGroup = await createGroup(owner, "JPY", "JPY units");
  await join(jpyGroup, b, owner);
  const jpyUnit = await createUnit(jpyGroup, owner, "tickets");
  const jpyExpense = await api(`/api/groups/${jpyGroup.id}/expenses`, owner, expenseBody(jpyGroup, jpyUnit.id, {
    title: "JPY unit", amountCents: 100, participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  const jpySaved = await expenseDetail(jpyExpense.id);
  check("unit shares use hundredths in JPY", jpySaved.shares.map((s: { shareCents: number }) => s.shareCents).sort((a: number, b: number) => a - b), [50, 50]);

  const beforeRejected = Number((await sql`SELECT count(*) FROM expenses WHERE group_id = ${g1.id}`)[0].count);
  const forged = await request(`/api/groups/${g1.id}/expenses`, owner, expenseBody(g1, otherGroupUnit.id, { title: "Forged" }));
  check("a unit from another group is rejected", forged.status, 400);
  check("a rejected forged expense writes nothing", Number((await sql`SELECT count(*) FROM expenses WHERE group_id = ${g1.id}`)[0].count), beforeRejected);
  check("a malformed amount is rejected", (await request(`/api/groups/${g1.id}/expenses`, owner, expenseBody(g1, drinks.id, { amountCents: 0 }))).status, 400);
  check("an empty unit name is rejected", (await request(`/api/groups/${g1.id}/units`, owner, { name: "   " })).status, 400);

  const beforeSettlements = Number((await sql`SELECT count(*) FROM settlements WHERE group_id = ${g1.id}`)[0].count);
  check("a forged unit settlement is rejected", (await request(`/api/groups/${g1.id}/settlements`, owner, {
    payerId: owner.id, recipientId: b.id, amountCents: 100, currency: g1.currency, unitId: otherGroupUnit.id, date: today, note: "forged unit",
  })).status, 400);
  check("a forged unit settlement writes nothing", Number((await sql`SELECT count(*) FROM settlements WHERE group_id = ${g1.id}`)[0].count), beforeSettlements);

  const beforeRecurring = Number((await sql`SELECT count(*) FROM recurring_expenses WHERE group_id = ${g1.id}`)[0].count);
  check("a forged unit recurring rule is rejected", (await request(`/api/groups/${g1.id}/recurring`, owner, {
    title: "Forged recurring", amountCents: 100, currency: g1.currency, unitId: otherGroupUnit.id,
    payerId: owner.id, participantIds: users.slice(0, 3).map((u) => u.id), notes: "", cadence: "monthly", startDate: today,
  })).status, 400);
  check("a forged unit recurring rule writes nothing", Number((await sql`SELECT count(*) FROM recurring_expenses WHERE group_id = ${g1.id}`)[0].count), beforeRecurring);

  const recurringUnit = await api(`/api/groups/${g1.id}/recurring`, owner, {
    title: "Recurring unit", amountCents: 100, currency: g1.currency, unitId: drinks.id,
    payerId: owner.id, participantIds: [owner.id, b.id], notes: "", cadence: "monthly", startDate: today,
  });
  const recurringRule = (await api(`/api/groups/${g1.id}/recurring`, owner)).recurring.find((row: { id: number }) => row.id === recurringUnit.id);
  const recurringEdit = await api(`/api/recurring/${recurringRule.id}`, owner, {
    title: recurringRule.title, amountCents: recurringRule.amountCents, currency: recurringRule.currency,
    payerId: recurringRule.payerId, participantIds: recurringRule.participantIds, notes: recurringRule.notes,
    cadence: recurringRule.cadence, nextDate: String(recurringRule.nextDate).slice(0, 10), active: true,
    expectedUpdatedAt: recurringRule.updatedAt,
  }, "PATCH");
  check("recurring edit without unitId keeps the unit", Number((await sql`SELECT unit_id FROM recurring_expenses WHERE id = ${recurringRule.id}`)[0].unit_id), drinks.id);
  await api(`/api/recurring/${recurringRule.id}?expectedUpdatedAt=${encodeURIComponent(recurringEdit.updatedAt)}`, owner, undefined, "DELETE");

  check("a unit on the direct settlement route is rejected", (await request("/api/settlements", owner, {
    friendId: b.id, direction: "i-paid", amountCents: 100, currency: g1.currency, unitId: drinks.id, date: today, note: "direct unit",
  })).status, 400);

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
  const offGross = unit.gross.find((row: { userId: number }) => row.userId === owner.id);
  check("OFF mode exposes the viewer's gross unit amounts", [offGross.owesCents, offGross.owedCents], [100, 200]);
  const offList = (await api("/api/groups", owner)).groups.find((row: { id: number }) => row.id === g1.id);
  const offListUnit = offList.unitNets.find((row: { unitId: number }) => row.unitId === offUnit.id);
  check("OFF mode group list keeps gross unit amounts", [offListUnit.reconcile, offListUnit.owesCents, offListUnit.owedCents], [false, 100, 200]);
  check("OFF group list unit summary matches detail", offList.unitNets.slice().sort((a: { unitId: number }, b: { unitId: number }) => a.unitId - b.unitId), detailUnitSummary(detail, owner.id));
  const offFriend = (await api("/api/friends", owner)).friends.find((row: { id: number }) => row.id === b.id);
  check("OFF friend unit summary matches detail", friendUnitObligations(offFriend, g1.id), detailUnitFriendObligations(detail, owner.id, b.id));

  const offRepayment = await api(`/api/groups/${g1.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 100, currency: g1.currency, unitId: offUnit.id, date: today, note: "repay",
  });
  detail = await api(`/api/groups/${g1.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "off");
  check("OFF repayment removes only that direct debt", byTriple(unit.obligations.map((row: { from: number; to: number; amountCents: number }) => [row.from, row.to, row.amountCents])), byTriple([
    [owner.id, b.id, 100], [c.id, owner.id, 100],
  ]));
  const outstandingAfterRepayment = await sql`
    SELECT unit_directed_obligation(${g1.id}, ${offUnit.id}, ${b.id}, ${owner.id}) AS cents`;
  check("DB sees no outstanding unit debt before the over-repayment", Number(outstandingAfterRepayment[0].cents), 0);
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
  const onList = (await api("/api/groups", owner)).groups.find((row: { id: number }) => row.id === g1.id);
  check("ON group list unit summary matches detail", onList.unitNets.slice().sort((a: { unitId: number }, b: { unitId: number }) => a.unitId - b.unitId), detailUnitSummary(detail, owner.id));
  const onFriend = (await api("/api/friends", owner)).friends.find((row: { id: number }) => row.id === b.id);
  check("ON friend unit summary matches detail", friendUnitObligations(onFriend, g1.id), detailUnitFriendObligations(detail, owner.id, b.id));

  await api(`/api/groups/${g1.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 500, currency: g1.currency, unitId: onUnit.id, date: today, note: "historic excess",
  });
  await api(`/api/groups/${g1.id}`, owner, { autoReconcileUnits: false }, "PATCH");
  detail = await api(`/api/groups/${g1.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "on");
  check("historic excess shows as the reverse obligation", unit.obligations.some((row: { from: number; to: number; amountCents: number }) => row.from === owner.id && row.to === b.id && row.amountCents > 0), true);
  await api(`/api/groups/${g1.id}`, owner, { autoReconcileUnits: true }, "PATCH");

  const reverseGroup = await createGroup(owner, "USD", "Reverse");
  await join(reverseGroup, b, owner);
  const reverseUnit = await createUnit(reverseGroup, owner, "reverse");
  await api(`/api/groups/${reverseGroup.id}`, owner, { autoReconcileUnits: false }, "PATCH");
  const reverseExpense = await api(`/api/groups/${reverseGroup.id}/expenses`, owner, expenseBody(reverseGroup, reverseUnit.id, {
    title: "Reverse debt", amountCents: 200, payerId: owner.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  await api(`/api/groups/${reverseGroup.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 100, currency: reverseGroup.currency,
    unitId: reverseUnit.id, date: today, note: "repay",
  });
  const reverseDetail = await api(`/api/expenses/${reverseExpense.id}`, owner);
  await api(`/api/expenses/${reverseExpense.id}?expectedUpdatedAt=${encodeURIComponent(reverseDetail.expense.updatedAt)}`, owner, undefined, "DELETE");
  detail = await api(`/api/groups/${reverseGroup.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "reverse");
  check("over-repayment appears as the reverse obligation", byTriple(unit.obligations.map((row: { from: number; to: number; amountCents: number }) => [row.from, row.to, row.amountCents])), byTriple([
    [owner.id, b.id, 100],
  ]));
  await api(`/api/groups/${reverseGroup.id}/settlements`, owner, {
    payerId: owner.id, recipientId: b.id, amountCents: 100, currency: reverseGroup.currency,
    unitId: reverseUnit.id, date: today, note: "clear reverse",
  });
  detail = await api(`/api/groups/${reverseGroup.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "reverse");
  check("reversed debt clears with one repayment", unit.obligations, []);
  check("reversed debt leaves both members settled", unit.nets.every((row: { netCents: number }) => row.netCents === 0), true);

  const pairGroup = await createGroup(owner, "USD", "Pair");
  await join(pairGroup, b, owner);
  const pairUnit = await createUnit(pairGroup, owner, "pair");
  await api(`/api/groups/${pairGroup.id}`, owner, { autoReconcileUnits: false }, "PATCH");
  const pairExpense = await api(`/api/groups/${pairGroup.id}/expenses`, b, expenseBody(pairGroup, pairUnit.id, {
    title: "Pair A", amountCents: 100, payerId: b.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  await api(`/api/groups/${pairGroup.id}/settlements`, owner, {
    payerId: owner.id, recipientId: b.id, amountCents: 50, currency: pairGroup.currency,
    unitId: pairUnit.id, date: today, note: "overpay",
  });
  const pairExpenseDetail = await api(`/api/expenses/${pairExpense.id}`, owner);
  await api(`/api/expenses/${pairExpense.id}?expectedUpdatedAt=${encodeURIComponent(pairExpenseDetail.expense.updatedAt)}`, owner, undefined, "DELETE");
  await api(`/api/groups/${pairGroup.id}/expenses`, owner, expenseBody(pairGroup, pairUnit.id, {
    title: "Pair B", amountCents: 100, payerId: owner.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  detail = await api(`/api/groups/${pairGroup.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "pair");
  check("normal debt plus overpayment shows one combined obligation", unit.obligations, [{ from: b.id, to: owner.id, amountCents: 100 }]);
  await api(`/api/groups/${pairGroup.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 100, currency: pairGroup.currency,
    unitId: pairUnit.id, date: today, note: "full repayment",
  });
  detail = await api(`/api/groups/${pairGroup.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "pair");
  check("full combined repayment clears the pair", unit.obligations, []);

  const raceGroup = await createGroup(owner, "USD", "Race");
  await join(raceGroup, b, owner);
  const raceUnit = await createUnit(raceGroup, owner, "race drinks");
  await api(`/api/groups/${raceGroup.id}/expenses`, owner, expenseBody(raceGroup, raceUnit.id, {
    title: "Race debt", amountCents: 200, payerId: owner.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  await api(`/api/groups/${raceGroup.id}`, owner, { autoReconcileUnits: false }, "PATCH");
  const raceBody = {
    payerId: b.id, recipientId: owner.id, amountCents: 100, currency: raceGroup.currency,
    unitId: raceUnit.id, date: today, note: "race",
  };
  const raceResults = await Promise.all([
    request(`/api/groups/${raceGroup.id}/settlements`, b, raceBody),
    request(`/api/groups/${raceGroup.id}/settlements`, b, raceBody),
  ]);
  check("concurrent unit repayments allow exactly one", raceResults.map((r) => r.status).sort(), [200, 400]);
  check("concurrent unit repayments write exactly one", Number((await sql`SELECT count(*) FROM settlements WHERE group_id = ${raceGroup.id}`)[0].count), 1);

  const removalGroup = await createGroup(owner, "USD", "Removal");
  await join(removalGroup, b, owner);
  const removalUnit = await createUnit(removalGroup, owner, "chores");
  await api(`/api/groups/${removalGroup.id}/expenses`, owner, expenseBody(removalGroup, removalUnit.id, {
    title: "Chore debt", amountCents: 100, payerId: owner.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  const blockedRemoval = await request(`/api/groups/${removalGroup.id}/members/${b.id}`, owner, undefined, "DELETE");
  check("member removal is blocked by an unsettled unit", blockedRemoval.status, 400);
  check("member removal names the unsettled unit", blockedRemoval.text.includes("chores"), true);
  check("blocked member removal keeps membership", Number((await sql`SELECT count(*) FROM group_members WHERE group_id = ${removalGroup.id} AND user_id = ${b.id}`)[0].count), 1);

  const removalOnGroup = await createGroup(owner, "USD", "Removal ON");
  await join(removalOnGroup, b, owner);
  const removalOnUnit = await createUnit(removalOnGroup, owner, "points");
  await api(`/api/groups/${removalOnGroup.id}/expenses`, owner, expenseBody(removalOnGroup, removalOnUnit.id, {
    title: "Points A", amountCents: 200, payerId: owner.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  await api(`/api/groups/${removalOnGroup.id}/expenses`, b, expenseBody(removalOnGroup, removalOnUnit.id, {
    title: "Points B", amountCents: 200, payerId: b.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  const allowedOnRemoval = await request(`/api/groups/${removalOnGroup.id}/members/${b.id}`, owner, undefined, "DELETE");
  check("ON member removal allows net-zero pairwise debts", allowedOnRemoval.status, 200);

  const formerGroup = await createGroup(owner, "USD", "Former");
  await join(formerGroup, b, owner);
  await join(formerGroup, c, owner);
  const formerUnit = await createUnit(formerGroup, owner, "former drinks");
  await api(`/api/groups/${formerGroup.id}/expenses`, owner, expenseBody(formerGroup, formerUnit.id, {
    title: "Former A", amountCents: 1000, payerId: owner.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  await api(`/api/groups/${formerGroup.id}/expenses`, b, expenseBody(formerGroup, formerUnit.id, {
    title: "Former B", amountCents: 1000, payerId: b.id,
    participants: [b, c].map((u) => ({ userId: u.id })),
  }));
  const formerRemoval = await request(`/api/groups/${formerGroup.id}/members/${b.id}`, owner, undefined, "DELETE");
  check("net-zero former member can leave", formerRemoval.status, 200);
  const formerOff = await request(`/api/groups/${formerGroup.id}`, owner, { autoReconcileUnits: false }, "PATCH");
  check("turning off succeeds with former-member unit debt", formerOff.status, 200);
  detail = await api(`/api/groups/${formerGroup.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "former drinks");
  check("former-member rows show after turning off", byTriple(unit.obligations.map((row: { from: number; to: number; amountCents: number }) => [row.from, row.to, row.amountCents])), byTriple([
    [b.id, owner.id, 500], [c.id, b.id, 500],
  ]));
  const formerRepay = await request(`/api/groups/${formerGroup.id}/settlements`, c, {
    payerId: c.id, recipientId: b.id, amountCents: 500, currency: formerGroup.currency,
    unitId: formerUnit.id, date: today, note: "former repay",
  });
  check("current member can repay a former member", formerRepay.status, 200);
  detail = await api(`/api/groups/${formerGroup.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "former drinks");
  check("former-member repayment clears that row", byTriple(unit.obligations.map((row: { from: number; to: number; amountCents: number }) => [row.from, row.to, row.amountCents])), byTriple([[b.id, owner.id, 500]]));
  const formerOn = await request(`/api/groups/${formerGroup.id}`, owner, { autoReconcileUnits: true }, "PATCH");
  check("turning cancelling back on succeeds after a former-member repayment", formerOn.status, 200);
  detail = await api(`/api/groups/${formerGroup.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "former drinks");
  check("open amount owed by a former member stays in the owner's net", unit.nets.find((row: { userId: number }) => row.userId === owner.id)?.netCents, 500);
  const formerOffAgain = await request(`/api/groups/${formerGroup.id}`, owner, { autoReconcileUnits: false }, "PATCH");
  check("turning cancelling off again succeeds", formerOffAgain.status, 200);
  const ownerFormerRepay = await request(`/api/groups/${formerGroup.id}/settlements`, owner, {
    payerId: b.id, recipientId: owner.id, amountCents: 500, currency: formerGroup.currency,
    unitId: formerUnit.id, date: today, note: "former repay 2",
  });
  check("recipient can record the former member's repayment", ownerFormerRepay.status, 200);
  detail = await api(`/api/groups/${formerGroup.id}`, owner);
  unit = detail.unitBalances.find((row: { name: string }) => row.name === "former drinks");
  check("former-member rows clear", unit.obligations, []);
  const nonSide = await request(`/api/groups/${formerGroup.id}/settlements`, c, {
    payerId: b.id, recipientId: owner.id, amountCents: 100, currency: formerGroup.currency,
    unitId: formerUnit.id, date: today, note: "non-side",
  });
  check("non-side member cannot record a former-member repayment", nonSide.status, 403);
  const stranger = await signup("stranger");
  const strangerRepay = await request(`/api/groups/${formerGroup.id}/settlements`, stranger, {
    payerId: b.id, recipientId: owner.id, amountCents: 100, currency: formerGroup.currency,
    unitId: formerUnit.id, date: today, note: "stranger",
  });
  check("stranger cannot record a former-member repayment", strangerRepay.status, 403);
  const neverMember = await request(`/api/groups/${formerGroup.id}/settlements`, owner, {
    payerId: stranger.id, recipientId: owner.id, amountCents: 100, currency: formerGroup.currency,
    unitId: formerUnit.id, date: today, note: "never member",
  });
  check("a never-member cannot be a unit repayment side", neverMember.status, 400);
  const moneyFormer = await request(`/api/groups/${formerGroup.id}/settlements`, owner, {
    payerId: b.id, recipientId: owner.id, amountCents: 100, currency: formerGroup.currency,
    date: today, note: "money former",
  });
  check("money with a former member is refused", moneyFormer.status, 400);

  const editGroup = await createGroup(owner, "USD", "Edit former");
  await join(editGroup, b, owner);
  await join(editGroup, c, owner);
  const editUnit = await createUnit(editGroup, owner, "edit drinks");
  await api(`/api/groups/${editGroup.id}/expenses`, owner, expenseBody(editGroup, editUnit.id, {
    title: "Edit former", amountCents: 1000, payerId: owner.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  await api(`/api/groups/${editGroup.id}/expenses`, b, expenseBody(editGroup, editUnit.id, {
    title: "Edit former back", amountCents: 1000, payerId: b.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  await request(`/api/groups/${editGroup.id}/members/${b.id}`, owner, undefined, "DELETE");
  await request(`/api/groups/${editGroup.id}`, owner, { autoReconcileUnits: false }, "PATCH");
  const recorded = await api(`/api/groups/${editGroup.id}/settlements`, owner, {
    payerId: b.id, recipientId: owner.id, amountCents: 200, currency: editGroup.currency,
    unitId: editUnit.id, date: today, note: "editable",
  });
  const above = await request(`/api/settlements/${recorded.id}`, owner, {
    amountCents: 600, currency: editGroup.currency, unitId: editUnit.id, date: today,
    note: "", expectedUpdatedAt: recorded.updatedAt,
  }, "PATCH");
  check("editing a former-member repayment above the obligation is refused", above.status, 400);
  const within = await request(`/api/settlements/${recorded.id}`, owner, {
    amountCents: 400, currency: editGroup.currency, unitId: editUnit.id, date: today,
    note: "within", expectedUpdatedAt: recorded.updatedAt,
  }, "PATCH");
  check("editing a former-member repayment within the obligation succeeds", within.status, 200);
  const removedFormer = await request(`/api/settlements/${recorded.id}?expectedUpdatedAt=${encodeURIComponent(within.data.updatedAt)}`, owner, undefined, "DELETE");
  check("deleting a former-member repayment succeeds", removedFormer.status, 200);

  const moneyEditGroup = await createGroup(owner, "USD", "Money edit");
  await join(moneyEditGroup, b, owner);
  const moneyEditUnit = await createUnit(moneyEditGroup, owner, "money edit drinks");
  await api(`/api/groups/${moneyEditGroup.id}/expenses`, owner, expenseBody(moneyEditGroup, moneyEditUnit.id, {
    title: "Money edit unit", amountCents: 1000, payerId: owner.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  await api(`/api/groups/${moneyEditGroup.id}/expenses`, b, expenseBody(moneyEditGroup, moneyEditUnit.id, {
    title: "Money edit unit back", amountCents: 1000, payerId: b.id,
    participants: [owner, b].map((u) => ({ userId: u.id })),
  }));
  await api(`/api/groups/${moneyEditGroup.id}/expenses`, owner, {
    title: "Money edit money", amountCents: 1000, currency: "USD", date: today, payerId: owner.id,
    notes: "", splitMethod: "equal", participants: [owner, b].map((u) => ({ userId: u.id })),
  });
  const moneySettlement = await api(`/api/groups/${moneyEditGroup.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 500, currency: "USD", date: today, note: "money",
  });
  await request(`/api/groups/${moneyEditGroup.id}/members/${b.id}`, owner, undefined, "DELETE");
  await request(`/api/groups/${moneyEditGroup.id}`, owner, { autoReconcileUnits: false }, "PATCH");
  const beforeMoneyEdit = await api(`/api/groups/${moneyEditGroup.id}`, owner);
  const moneyToUnit = await request(`/api/settlements/${moneySettlement.id}`, owner, {
    amountCents: 200, currency: "USD", unitId: moneyEditUnit.id, date: today,
    note: "", expectedUpdatedAt: moneySettlement.updatedAt,
  }, "PATCH");
  check("money-to-unit edit with a former member is refused", moneyToUnit.status, 400);
  const afterMoneyEdit = await api(`/api/groups/${moneyEditGroup.id}`, owner);
  check("refused money-to-unit edit leaves balances unchanged", afterMoneyEdit.balances, beforeMoneyEdit.balances);

  const friendBalancesAfter = await api("/api/friends", owner);
  const friendB = friendBalancesAfter.friends.find((row: { id: number }) => row.id === b.id);
  const unitObligations = friendB.obligations.filter((row: { kind?: string }) => row.kind === "unit");
  check("friend balances show unit obligations separately", unitObligations.length > 0 && unitObligations.every((row: { unitId?: number; unitName?: string }) => row.unitId && row.unitName), true);
  const peopleAfter = (await api(`/api/people/${b.id}`, owner)).profile;
  check("people balances show unit obligations separately", peopleAfter.obligations.some((row: { kind?: string; unitId?: number }) => row.kind === "unit" && row.unitId), true);

  const editId = await unitExpense(g1, drinks.id, { title: "Edit me", amountCents: 300 });
  const editBefore = await expenseDetail(editId);
  await api(`/api/expenses/${editId}`, owner, expenseBody(g1, drinks.id, {
    title: "Edited unit", amountCents: 400, expectedUpdatedAt: editBefore.updatedAt,
  }), "PATCH");
  const editAfter = await expenseDetail(editId);
  check("edit keeps the unit and denomination", [editAfter.title, editAfter.unitId, editAfter.unitName, editAfter.convertedCents], ["Edited unit", drinks.id, "drink tickets", 400]);
  await api(`/api/expenses/${editId}?expectedUpdatedAt=${encodeURIComponent(editAfter.updatedAt)}`, owner, undefined, "DELETE");
  check("delete a unit expense", Number((await sql`SELECT count(*) FROM expenses WHERE id = ${editId}`)[0].count), 0);

  const moneyToUnitId = Number((await api(`/api/groups/${g1.id}/expenses`, owner, {
    title: "Money to unit", amountCents: 200, currency: g1.currency, unitId: null,
    date: today, payerId: owner.id, notes: "", splitMethod: "equal",
    participants: users.slice(0, 3).map((u) => ({ userId: u.id })),
  })).id);
  const moneyToUnitBefore = await expenseDetail(moneyToUnitId);
  await api(`/api/expenses/${moneyToUnitId}`, owner, expenseBody(g1, drinks.id, {
    title: "Money to unit", amountCents: 200, expectedUpdatedAt: moneyToUnitBefore.updatedAt,
  }), "PATCH");
  const moneyToUnitAfter = await expenseDetail(moneyToUnitId);
  check("edit money to unit keeps the unit", [moneyToUnitAfter.unitId, moneyToUnitAfter.unitName, moneyToUnitAfter.convertedCents], [drinks.id, "drink tickets", 200]);
  await api(`/api/expenses/${moneyToUnitId}`, owner, expenseBody(g1, null, {
    title: "Unit to money", amountCents: 200, expectedUpdatedAt: moneyToUnitAfter.updatedAt,
  }), "PATCH");
  const unitToMoneyAfter = await expenseDetail(moneyToUnitId);
  check("edit unit to money clears the unit", [unitToMoneyAfter.unitId, unitToMoneyAfter.unitName, unitToMoneyAfter.convertedCents], [null, null, 200]);
  await api(`/api/expenses/${moneyToUnitId}?expectedUpdatedAt=${encodeURIComponent(unitToMoneyAfter.updatedAt)}`, owner, undefined, "DELETE");

  const settlementId = (await api(`/api/groups/${g1.id}/settlements`, b, {
    payerId: b.id, recipientId: owner.id, amountCents: 50, currency: g1.currency, unitId: drinks.id, date: today, note: "edit settlement",
  })).id;
  const settlementRow = (await api(`/api/groups/${g1.id}/settlements`, owner)).settlements.find((s: { id: number }) => s.id === settlementId);
  const paymentHistory = await api(`/api/settlements?friendId=${b.id}`, owner);
  const historyUnit = paymentHistory.settlements.find((s: { id: number }) => s.id === settlementId);
  check("payment history carries unit fields", [historyUnit.unitId, historyUnit.unitName], [drinks.id, "drink tickets"]);
  const settlementEdit = await api(`/api/settlements/${settlementId}`, b, {
    amountCents: 60, currency: g1.currency, unitId: drinks.id, date: today, note: "edited", expectedUpdatedAt: settlementRow.updatedAt,
  }, "PATCH");
  check("edit a unit settlement", Number((await sql`SELECT amount_cents FROM settlements WHERE id = ${settlementId}`)[0].amount_cents), 60);
  await api(`/api/settlements/${settlementId}?expectedUpdatedAt=${encodeURIComponent(settlementEdit.updatedAt)}`, b, undefined, "DELETE");
  check("delete a unit settlement", Number((await sql`SELECT count(*) FROM settlements WHERE id = ${settlementId}`)[0].count), 0);

  const unitActivity = await sql`
    SELECT count(*)::int AS count FROM activity
    WHERE group_id = ${g1.id} AND type IN ('group_unit.added', 'group.units_reconcile')`;
  check("unit activity reaches the refresh path", Number(unitActivity[0].count) >= 2, true);

  const moneyAfter = await moneySnapshot(g1);
  check("money balances are byte-identical after unit data", moneyAfter, moneyBefore);
  const moneyAfterData = JSON.parse(moneyAfter);
  const moneyBeforeData = JSON.parse(moneyBefore);
  check("money insights rows are unchanged", moneyAfterData.insights, moneyBeforeData.insights);
  check("money insights total is unchanged", moneyAfterData.insightsTotal, moneyExpensesBefore);
  check("money export total is unchanged", moneyAfterData.exportMoney, moneyBeforeData.exportMoney);
  check("friend money balances are unchanged", moneyAfterData.friendMoney, moneyBeforeData.friendMoney);
  check("people money balances are unchanged", moneyAfterData.peopleMoney, moneyBeforeData.peopleMoney);

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
  console.error(error instanceof Error ? error.stack : String(error));
  await cleanup().catch(() => {});
  process.exitCode = 1;
});
