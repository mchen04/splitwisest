import { randomBytes } from "node:crypto";
import "../src/lib/neon-local";
import { neon } from "@neondatabase/serverless";
import { strict as assert } from "node:assert";

const base = new URL(process.env.SPLITWISEST_BASE_URL ?? "http://127.0.0.1:3741");
const database = new URL(process.env.DATABASE_URL ?? "http://invalid");
assert(["127.0.0.1", "localhost"].includes(base.hostname) && /^374[0-9]$/.test(base.port), "Use the isolated local app");
assert(/^\/sw_codex[a-z0-9_]*$/.test(database.pathname) && process.env.NEON_LOCAL_PROXY, "Use an isolated sw_codex database");
const sql = neon(process.env.DATABASE_URL!);
const failures: string[] = [];
let passed = 0;
let state = 7301;
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
let today = "";
const step = (currency: string) => ["JPY", "KRW"].includes(currency) ? 100 : 1;
type User = { id: number; cookie: string; name: string };
type Group = { id: number; currency: string; name: string };
type Body = Record<string, unknown>;
type Transfer = { from: number; to: number; amountCents: number };
const users: User[] = [];
const groups: Group[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  try { assert.deepEqual(actual, expected); passed++; }
  catch { failures.push(name); console.error(`FAIL ${name}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`); }
}

async function request(path: string, user?: User, body?: Body, method = body ? "POST" : "GET") {
  const res = await fetch(new URL(path, base), {
    method, headers: { ...(user ? { cookie: user.cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, data: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

async function api(path: string, user?: User, body?: Body, method?: string) {
  const r = await request(path, user, body, method);
  assert.equal(r.status, 200, `${path}: ${r.status} ${r.text}`);
  return r.data;
}

function allocation(total: number, weights: { id: number; weight: bigint }[], unit = 1, tieById = false) {
  const denominator = weights.reduce((s, w) => s + w.weight, BigInt(0));
  const rows = weights.map((w, index) => ({ ...w, index, cents: BigInt(total / unit) * w.weight / denominator,
    remainder: BigInt(total / unit) * w.weight % denominator }));
  const spare = Number(BigInt(total / unit) - rows.reduce((s, w) => s + w.cents, BigInt(0)));
  const order = [...rows].sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : tieById ? a.id - b.id : a.index - b.index);
  for (const row of order.slice(0, spare)) row.cents++;
  return new Map(rows.map((w) => [w.id, Number(w.cents) * unit]));
}

function greedy(net: Map<number, number>): Transfer[] {
  const creditors = [...net].filter(([, n]) => n > 0).map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n || a.id - b.id);
  const debtors = [...net].filter(([, n]) => n < 0).map(([id, n]) => ({ id, n: -n })).sort((a, b) => b.n - a.n || a.id - b.id);
  const out: Transfer[] = [];
  for (const debtor of debtors) for (const creditor of creditors) {
    const amountCents = Math.min(debtor.n, creditor.n);
    if (amountCents) out.push({ from: debtor.id, to: creditor.id, amountCents });
    debtor.n -= amountCents; creditor.n -= amountCents;
  }
  return out;
}

function oraclePlan(net: Map<number, number>): Transfer[] {
  const entries = [...net].filter(([, n]) => n).sort(([a], [b]) => a - b);
  let best: { score: number; order: number[] } | undefined;
  function visit(order: number[], remaining: number[], sum: number, score: number) {
    if (!remaining.length) {
      if (!best || score > best.score) best = { score, order };
      return;
    }
    for (const i of remaining) {
      const next = sum + entries[i][1];
      visit([...order, i], remaining.filter((j) => j !== i), next, score + (next === 0 ? 1 : 0));
    }
  }
  visit([], entries.map((_, i) => i), 0, 0);
  const transfers: Transfer[] = [];
  let group = new Map<number, number>();
  let sum = 0;
  for (const i of best?.order ?? []) {
    group.set(...entries[i]); sum += entries[i][1];
    if (sum === 0) { transfers.push(...greedy(group)); group = new Map(); }
  }
  return transfers;
}

const netRows = (net: Map<number, number>) => [...net].sort(([a], [b]) => a - b);
async function groupData(group: Group) { return api(`/api/groups/${group.id}`, users[0]); }
async function snapshot(group: Group) {
  const detail = await groupData(group);
  return detail.balances.map((b: { userId: number; netCents: number }) => [b.userId, b.netCents]).sort((a: number[], b: number[]) => a[0] - b[0]);
}
function expenseBody(group: Group, extra: Body = {}) {
  return { title: "Audit expense", amountCents: 1001 * step(group.currency), currency: group.currency, date: today,
    payerId: users[0].id, notes: "synthetic", splitMethod: "equal", participants: users.slice(0, 3).map((u) => ({ userId: u.id })), ...extra };
}
async function expense(group: Group, extra: Body = {}) {
  return Number((await api(`/api/groups/${group.id}/expenses`, users[0], expenseBody(group, extra))).id);
}
async function detail(id: number) { return (await api(`/api/expenses/${id}`, users[0])).expense; }
async function editExpense(group: Group, id: number, extra: Body) {
  const old = await detail(id);
  await api(`/api/expenses/${id}`, users[0], expenseBody(group, { ...extra, expectedUpdatedAt: old.updatedAt }), "PATCH");
  return old;
}
async function removeExpense(id: number) {
  const e = await detail(id);
  await api(`/api/expenses/${id}?expectedUpdatedAt=${encodeURIComponent(e.updatedAt)}`, users[0], undefined, "DELETE");
}
function csv(text: string) {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === "," || c === "\n")) { row.push(field); field = ""; if (c === "\n") { rows.push(row); row = []; } }
    else field += c;
  }
  return rows;
}

async function reconcile(label: string) {
  const plans = new Map<number, Transfer[]>();
  for (const group of groups) {
    const memberRows = await sql`SELECT user_id FROM group_members WHERE group_id = ${group.id}`;
    const net = new Map<number, number>(memberRows.map((r) => [Number(r.user_id), 0]));
    const add = (id: number, cents: number) => net.set(id, net.get(id)! + cents);
    const expenses = await sql`SELECT * FROM expenses WHERE group_id = ${group.id} ORDER BY expense_date, id`;
    const list = await api(`/api/groups/${group.id}/expenses?limit=200`, users[0]);
    for (const e of expenses) {
      const shares = await sql`SELECT user_id, share_cents FROM expense_shares WHERE expense_id = ${e.id} ORDER BY user_id`;
      check(`${label}: expense ${e.id} original share sum`, shares.reduce((s, r) => s + Number(r.share_cents), 0), Number(e.amount_cents));
      const allocated = allocation(Number(e.converted_cents), shares.map((r) => ({ id: Number(r.user_id), weight: BigInt(r.share_cents) })), step(group.currency), true);
      check(`${label}: expense ${e.id} converted share sum`, [...allocated.values()].reduce((s, n) => s + n, 0), Number(e.converted_cents));
      add(Number(e.payer_id), Number(e.converted_cents));
      for (const [id, cents] of allocated) add(id, -cents);
      const shown = list.expenses.find((r: { id: number }) => r.id === Number(e.id));
      check(`${label}: expense ${e.id} displayed conversion`, shown.shares.map((r: { userId: number; convertedShareCents: number }) => [Number(r.userId), Number(r.convertedShareCents)]).sort((a: number[], b: number[]) => a[0] - b[0]), netRows(allocated));
    }
    const obligations = await sql`SELECT a.* FROM group_obligation_allocations a JOIN group_obligations g ON g.id = a.obligation_id WHERE g.group_id = ${group.id}`;
    for (const a of obligations) add(Number(a.user_id), (a.side === "receives" ? 1 : -1) * Number(a.share_cents));
    const settlements = await sql`SELECT * FROM settlements WHERE group_id = ${group.id}`;
    for (const s of settlements) { add(Number(s.payer_id), Number(s.converted_cents)); add(Number(s.recipient_id), -Number(s.converted_cents)); }
    check(`${label}: ${group.currency} independent sum`, [...net.values()].reduce((s, n) => s + n, 0), 0);
    const raw = await sql`SELECT user_id, net_cents FROM group_balance_rows(${group.id})`;
    check(`${label}: ${group.currency} SQL balances`, raw.map((r) => [Number(r.user_id), Number(r.net_cents)]).sort((a, b) => a[0] - b[0]), netRows(net));
    const data = await groupData(group);
    check(`${label}: ${group.currency} API balances`, data.balances.map((b: { userId: number; netCents: number }) => [b.userId, b.netCents]).sort((a: number[], b: number[]) => a[0] - b[0]), netRows(net));
    const cleared = new Map(net);
    for (const t of data.suggestions) { cleared.set(t.from, cleared.get(t.from)! + t.amountCents); cleared.set(t.to, cleared.get(t.to)! - t.amountCents); }
    check(`${label}: ${group.currency} suggestions clear independent nets`, [...cleared.values()], [...cleared.values()].map(() => 0));
    const plan = oraclePlan(net);
    check(`${label}: ${group.currency} independent minimum payment count`, data.suggestions.length, plan.length);
    check(`${label}: ${group.currency} deterministic suggestions`, data.suggestions, plan);
    plans.set(group.id, plan);
    const exported = await request(`/api/groups/${group.id}/export`, users[0]);
    assert.equal(exported.status, 200);
    const records = csv(exported.text).slice(1);
    check(`${label}: ${group.currency} CSV row count`, records.length, expenses.length);
    check(`${label}: ${group.currency} CSV converted total`, records.reduce((s, r) => s + Math.round(Number(r[4]) * 100), 0), expenses.reduce((s, r) => s + Number(r.converted_cents), 0));
    for (let i = 0; i < records.length; i++) check(`${label}: CSV ${expenses[i].id} share total`, records[i][9].split("; ").reduce((s, value) => s + Math.round(Number(value.split(": ").at(-1)) * 100), 0), Number(expenses[i].amount_cents));
    const insight = await api(`/api/groups/${group.id}/expenses?all=1`, users[0]);
    check(`${label}: ${group.currency} insights total`, insight.expenses.reduce((s: number, e: { convertedCents: number }) => s + e.convertedCents, 0), expenses.reduce((s, e) => s + Number(e.converted_cents), 0));
  }
  const direct = await sql`SELECT * FROM settlements WHERE group_id IS NULL AND payer_id = ANY(${users.map((u) => u.id)})`;
  for (const user of users) {
    const friends = (await api("/api/friends", user)).friends;
    const groupList = (await api("/api/groups", user)).groups;
    for (const group of groups) {
      const raw = await sql`SELECT net_cents FROM group_balance_rows(${group.id}) WHERE user_id = ${user.id}`;
      check(`${label}: user ${user.id} group-list net ${group.id}`, groupList.find((g: { id: number }) => g.id === group.id).myNetCents, Number(raw[0].net_cents));
    }
    for (const friend of users.filter((u) => u.id !== user.id)) {
      const expected: { groupId: number | null; currency: string; netCents: number }[] = [];
      for (const group of groups) for (const t of plans.get(group.id)!) {
        if (t.from === user.id && t.to === friend.id) expected.push({ groupId: group.id, currency: group.currency, netCents: -t.amountCents });
        if (t.to === user.id && t.from === friend.id) expected.push({ groupId: group.id, currency: group.currency, netCents: t.amountCents });
      }
      const directNet: Record<string, number> = {};
      for (const s of direct) if ([user.id, friend.id].includes(Number(s.payer_id)) && [user.id, friend.id].includes(Number(s.recipient_id))) {
        directNet[s.currency] = (directNet[s.currency] ?? 0) + (Number(s.payer_id) === user.id ? 1 : -1) * Number(s.converted_cents);
      }
      for (const [currency, netCents] of Object.entries(directNet)) if (netCents) expected.push({ groupId: null, currency, netCents });
      const normalize = (rows: typeof expected) => rows.map((r) => [r.groupId, r.currency, r.netCents]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const f = friends.find((f: { id: number }) => f.id === friend.id);
      check(`${label}: friend ${user.id}/${friend.id} obligations`, normalize(f.obligations), normalize(expected));
      const net: Record<string, number> = {};
      for (const o of expected) { net[o.currency] = (net[o.currency] ?? 0) + o.netCents; if (!net[o.currency]) delete net[o.currency]; }
      check(`${label}: friend ${user.id}/${friend.id} net currencies`, f.netByCurrency, net);
      const profile = await api(`/api/people/${friend.id}`, user);
      check(`${label}: person ${user.id}/${friend.id} obligations`, normalize(profile.profile.obligations), normalize(expected));
    }
  }
}

async function main() {
  today = (await sql`SELECT CURRENT_DATE::text AS day`)[0].day as string;
  assert.equal((await sql`SELECT 1 FROM users WHERE username LIKE 'money_audit_%'`).length, 0, "Reset the isolated database before rerunning");
  for (const [currency, rate] of Object.entries({ USD: 1, EUR: 0.8, GBP: 0.7, JPY: 149.5, KRW: 1370 })) {
    await sql`INSERT INTO fx_rates(currency, rate_per_usd, fetched_at) VALUES(${currency}, ${rate}, now()) ON CONFLICT(currency) DO UPDATE SET rate_per_usd = EXCLUDED.rate_per_usd, fetched_at = now()`;
  }
  for (let i = 0; i < 4; i++) {
    const r = await request("/api/auth/signup", undefined, { username: `money_audit_${i}`, displayName: `Audit ${3 - i}`, password: process.env.SPLITWISEST_MONEY_QA_PASSWORD ?? randomBytes(32).toString("hex") });
    assert.equal(r.status, 200, r.text); assert(r.cookie);
    const me = await api("/api/me", { cookie: r.cookie } as User);
    users.push({ id: me.user.id, cookie: r.cookie, name: me.user.displayName });
  }
  for (const currency of ["USD", "EUR", "JPY", "KRW"]) {
    const g = await api("/api/groups", users[0], { name: `Money audit ${currency}`, currency });
    groups.push({ id: g.id, currency, name: `Money audit ${currency}` });
    for (const u of users.slice(1)) await api("/api/groups/join", u, { code: g.inviteCode });
  }
  for (const group of groups) {
    for (const method of ["equal", "exact", "percentage", "shares", "itemized"]) {
      const unit = step(group.currency); const total = (1001 + Math.floor(random() * 100)) * unit;
      const participants = users.slice(0, 3).map((u, i) => ({ userId: u.id,
        ...(method === "exact" ? { value: i === 0 ? total - 3 * unit : i * unit } : method === "percentage" ? { value: [33.33, 33.33, 33.34][i] } : method === "shares" ? { value: i + 1 } : {}) }));
      const items = [{ name: "Shared", amountCents: total - 2 * unit, participantIds: users.slice(0, 3).map((u) => u.id) }];
      const id = await expense(group, { title: `Audit ${method}`, amountCents: total, splitMethod: method, participants,
        ...(method === "itemized" ? { items, itemizedTaxCents: unit, itemizedTipCents: unit } : {}) });
      const saved = await detail(id);
      const expected = method === "exact" ? new Map(participants.map((p) => [p.userId, p.value!])) : method === "itemized" ? (() => {
        const amounts = allocation(total - 2 * unit, participants.map((p) => ({ id: p.userId, weight: BigInt(1) })), unit);
        const adjustments = allocation(2 * unit, [...amounts].map(([id, n]) => ({ id, weight: BigInt(n) })), unit);
        return new Map([...amounts].map(([id, n]) => [id, n + adjustments.get(id)!]));
      })() : allocation(total, participants.map((p, i) => ({ id: p.userId, weight: BigInt(method === "equal" ? 1 : method === "shares" ? i + 1 : [3333, 3333, 3334][i]) })), unit);
      check(`${group.currency} ${method} API shares`, saved.shares.map((p: { userId: number; shareCents: number }) => [p.userId, p.shareCents]).sort((a: number[], b: number[]) => a[0] - b[0]), netRows(expected));
    }
    await expense(group, { title: "FX expense", currency: group.currency === "USD" ? "EUR" : "USD", amountCents: 1001 });
    const side = (method: string, ids: number[], values?: number[]) => ({ method, participants: ids.map((userId, i) => ({ userId, ...(values ? { value: values[i] } : {}) })) });
    const input = { title: "Audit allocation", amountCents: 101 * step(group.currency),
      owes: side("percentage", [users[0].id, users[1].id], [25, 75]), receives: side("shares", [users[1].id, users[2].id], [1, 2]),
      expectedBalances: await snapshot(group), clientRequestId: `00000000-0000-4000-8000-${String(group.id).padStart(12, "0")}` };
    const obligation = await api(`/api/groups/${group.id}/group-balances`, users[0], input);
    const retry = await api(`/api/groups/${group.id}/group-balances`, users[0], input);
    check(`${group.currency} allocation create retry`, retry.id, obligation.id);
    const saved = (await api(`/api/group-balances/${obligation.id}`, users[0])).balance;
    check(`${group.currency} owes percentage allocation`, saved.owes.participants.map((p: { userId: number; shareCents: number }) => [p.userId, p.shareCents]), netRows(allocation(input.amountCents, [{ id: users[0].id, weight: BigInt(25) }, { id: users[1].id, weight: BigInt(75) }], step(group.currency), true)));
    check(`${group.currency} receives shares allocation`, saved.receives.participants.map((p: { userId: number; shareCents: number }) => [p.userId, p.shareCents]), netRows(allocation(input.amountCents, [{ id: users[1].id, weight: BigInt(1) }, { id: users[2].id, weight: BigInt(2) }], step(group.currency), true)));
    const changed = { ...input, owes: side("exact", [users[0].id, users[3].id], [100 * step(group.currency), step(group.currency)]), receives: side("equal", [users[0].id, users[2].id]), expectedBalances: await snapshot(group), expectedUpdatedAt: saved.updatedAt };
    await api(`/api/group-balances/${obligation.id}`, users[0], changed, "PATCH");
    const stale = await request(`/api/group-balances/${obligation.id}`, users[0], changed, "PATCH"); check(`${group.currency} stale allocation edit`, stale.status, 400);
    const edited = (await api(`/api/group-balances/${obligation.id}`, users[0])).balance;
    check(`${group.currency} owes exact rewrite`, edited.owes.participants.map((p: { userId: number; shareCents: number }) => [p.userId, p.shareCents]), [[users[0].id, 100 * step(group.currency)], [users[3].id, step(group.currency)]]);
    check(`${group.currency} receives equal rewrite`, edited.receives.participants.map((p: { userId: number; shareCents: number }) => [p.userId, p.shareCents]), [[users[0].id, 51 * step(group.currency)], [users[2].id, 50 * step(group.currency)]]);
    check(`${group.currency} stale allocation delete`, (await request(`/api/group-balances/${obligation.id}?expectedUpdatedAt=${encodeURIComponent(saved.updatedAt)}`, users[0], undefined, "DELETE")).status, 400);
    const temporary = await api(`/api/groups/${group.id}/group-balances`, users[0], { ...input, expectedBalances: await snapshot(group), clientRequestId: `00000000-0000-4000-9000-${String(group.id).padStart(12, "0")}` });
    const tempSaved = (await api(`/api/group-balances/${temporary.id}`, users[0])).balance;
    await api(`/api/group-balances/${temporary.id}?expectedUpdatedAt=${encodeURIComponent(tempSaved.updatedAt)}`, users[0], undefined, "DELETE");
    check(`${group.currency} allocation delete removes both sides`, Number((await sql`SELECT count(*) FROM group_obligation_allocations WHERE obligation_id = ${temporary.id}`)[0].count), 0);
  }
  await reconcile("created");
  const usd = groups[0];
  await expense(usd, { title: "Maximum amount CSV", amountCents: 100_000_000_000, participants: [{ userId: users[0].id }] });
  const tiny = await request(`/api/groups/${usd.id}/expenses`, users[0], expenseBody(usd, { title: "Tiny converted expense", amountCents: 100, currency: "KRW" }));
  check("tiny positive FX expense status", tiny.status, 200);
  if (tiny.status === 200) check("tiny positive FX expense persists", (await detail(Number(tiny.data.id))).convertedCents, 1);
  const reorderId = await expense(usd, { amountCents: 101, participants: users.slice(0, 2).map((u) => ({ userId: u.id })) });
  const reorderBefore = await detail(reorderId);
  await editExpense(usd, reorderId, { title: "Title only", amountCents: 101, participants: users.slice(0, 2).reverse().map((u) => ({ userId: u.id })) });
  check("title edit preserves awarded remainder cents", (await detail(reorderId)).shares.map((s: { userId: number; shareCents: number }) => [s.userId, s.shareCents]).sort(), reorderBefore.shares.map((s: { userId: number; shareCents: number }) => [s.userId, s.shareCents]).sort());
  const changedId = await expense(usd);
  const previous = await editExpense(usd, changedId, { title: "Edited exact", amountCents: 313, payerId: users[1].id, splitMethod: "exact", participants: [{ userId: users[2].id, value: 100 }, { userId: users[3].id, value: 213 }] });
  check("stale expense edit", (await request(`/api/expenses/${changedId}`, users[0], expenseBody(usd, { expectedUpdatedAt: previous.updatedAt }), "PATCH")).status, 400);
  check("stale expense delete", (await request(`/api/expenses/${changedId}?expectedUpdatedAt=${encodeURIComponent(previous.updatedAt)}`, users[0], undefined, "DELETE")).status, 400);
  const history = await api(`/api/expenses/${changedId}/history`, users[0]);
  check("expense edit history", history.edits.length, 1);
  const itemId = await expense(usd, { splitMethod: "itemized", amountCents: 1101,
    participants: users.slice(0, 2).map((u) => ({ userId: u.id })),
    items: [{ name: "Initial", amountCents: 1000, participantIds: [users[0].id, users[1].id] }], itemizedTaxCents: 101 });
  await editExpense(usd, itemId, { splitMethod: "itemized", amountCents: 1101,
    participants: [{ userId: users[2].id }], items: [{ name: "Rewritten", amountCents: 1000, participantIds: [users[2].id] }], itemizedTipCents: 101 });
  const itemSaved = await detail(itemId);
  check("itemized edit replaces shares and adjustments", [itemSaved.shares.map((s: { userId: number; shareCents: number }) => [s.userId, s.shareCents]), itemSaved.itemizedTaxCents, itemSaved.itemizedTipCents], [[[users[2].id, 1101]], 0, 101]);
  check("itemized edit replaces items", itemSaved.items.map((i: { name: string; amountCents: number; participantIds: number[] }) => [i.name, i.amountCents, i.participantIds]), [["Rewritten", 1000, [users[2].id]]]);
  await removeExpense(await expense(usd, { title: "Delete fixture" }));
  const fxId = await expense(usd, { amountCents: 1234, currency: "EUR" });
  const fxBefore = await detail(fxId);
  await sql`UPDATE fx_rates SET rate_per_usd = 0.5, fetched_at = now() WHERE currency = 'EUR'`;
  await editExpense(usd, fxId, { amountCents: 1234, currency: "EUR", notes: "note only" });
  check("expense FX snapshot on note edit", (await detail(fxId)).convertedCents, fxBefore.convertedCents);
  await editExpense(usd, fxId, { amountCents: 1235, currency: "EUR" });
  check("expense FX snapshot on amount edit", (await detail(fxId)).convertedCents, 2470);
  const payBody = { payerId: users[1].id, recipientId: users[0].id, amountCents: 123, currency: "EUR", date: today, note: "group FX" };
  const pay = await api(`/api/groups/${usd.id}/settlements`, users[0], payBody);
  await sql`UPDATE fx_rates SET rate_per_usd = 0.8, fetched_at = now() WHERE currency = 'EUR'`;
  const payEdit = await api(`/api/settlements/${pay.id}`, users[0], { ...payBody, note: "note only", expectedUpdatedAt: pay.updatedAt }, "PATCH");
  check("settlement FX snapshot on note edit", Number((await sql`SELECT converted_cents FROM settlements WHERE id = ${pay.id}`)[0].converted_cents), 246);
  check("stale settlement edit", (await request(`/api/settlements/${pay.id}`, users[0], { ...payBody, expectedUpdatedAt: pay.updatedAt }, "PATCH")).status, 400);
  check("stale settlement delete", (await request(`/api/settlements/${pay.id}?expectedUpdatedAt=${encodeURIComponent(pay.updatedAt)}`, users[0], undefined, "DELETE")).status, 400);
  const payEdit2 = await api(`/api/settlements/${pay.id}`, users[0], { ...payBody, amountCents: 124, expectedUpdatedAt: payEdit.updatedAt }, "PATCH");
  check("settlement FX snapshot on amount edit", Number((await sql`SELECT converted_cents FROM settlements WHERE id = ${pay.id}`)[0].converted_cents), 155);
  await api(`/api/settlements/${pay.id}?expectedUpdatedAt=${encodeURIComponent(payEdit2.updatedAt)}`, users[0], undefined, "DELETE");
  for (const currency of ["USD", "EUR", "JPY"]) {
    const d = await api("/api/settlements", users[0], { friendId: users[1].id, direction: "i-paid", amountCents: 101 * step(currency), currency, date: today, note: "direct" });
    const edit = await api(`/api/settlements/${d.id}`, users[0], { amountCents: 103 * step(currency), currency, date: today, note: "edited", expectedUpdatedAt: d.updatedAt }, "PATCH");
    const wrong = await request("/api/settlements", users[0], { friendId: users[1].id, direction: "they-paid", amountCents: 102 * step(currency), currency, date: today, settleFullBalance: true });
    check(`${currency} stale direct full balance`, wrong.status, 400);
    const fullBody = { friendId: users[1].id, direction: "they-paid", amountCents: 103 * step(currency), currency, date: today, settleFullBalance: true };
    const full = await Promise.all([request("/api/settlements", users[0], fullBody), request("/api/settlements", users[0], fullBody)]);
    check(`${currency} concurrent direct full balance`, full.map((r) => r.status).sort(), [200, 400]);
    check(`${currency} full direct clears pair`, Number((await sql`SELECT sum(CASE WHEN payer_id = ${users[0].id} THEN converted_cents ELSE -converted_cents END) AS net FROM settlements WHERE group_id IS NULL AND currency = ${currency} AND payer_id = ANY(${[users[0].id, users[1].id]}) AND recipient_id = ANY(${[users[0].id, users[1].id]})`)[0].net), 0);
    await api(`/api/settlements/${d.id}?expectedUpdatedAt=${encodeURIComponent(edit.updatedAt)}`, users[0], undefined, "DELETE");
  }
  const yen = groups[2];
  const crossPay = await api(`/api/groups/${yen.id}/settlements`, users[0], { payerId: users[0].id, recipientId: users[1].id, amountCents: 1, currency: "USD", date: today });
  check("foreign settlement rounds once to whole yen", Number((await sql`SELECT converted_cents FROM settlements WHERE id = ${crossPay.id}`)[0].converted_cents), 100);
  check("whole-yen expense rejects fractional total", (await request(`/api/groups/${yen.id}/expenses`, users[0], expenseBody(yen, { amountCents: 155 }))).status, 400);
  check("whole-yen settlement rejects fractional total", (await request(`/api/groups/${yen.id}/settlements`, users[0], { payerId: users[0].id, recipientId: users[1].id, amountCents: 155, currency: "JPY", date: today })).status, 400);
  check("whole-yen direct rejects fractional total", (await request("/api/settlements", users[0], { friendId: users[1].id, direction: "i-paid", amountCents: 155, currency: "JPY", date: today })).status, 400);
  const ruleBody = { title: "Monthly month-end", amountCents: 901, currency: "USD", payerId: users[0].id, participantIds: users.slice(0, 3).map((u) => u.id), notes: "synthetic", cadence: "monthly", startDate: "2026-01-31" };
  const rule = await api(`/api/groups/${usd.id}/recurring`, users[0], ruleBody);
  await Promise.all(Array.from({ length: 3 }, () => groupData(usd)));
  const dates = (await sql`SELECT expense_date::text AS day FROM expenses WHERE recurring_id = ${rule.id} ORDER BY expense_date`).map((r) => r.day);
  const expectedDates = [];
  for (let month = 0; month < 12; month++) { const date = new Date(Date.UTC(2026, month + 1, 0)).toISOString().slice(0, 10); if (date <= today) expectedDates.push(date); }
  check("monthly anchor and concurrent idempotence", dates, expectedDates);
  const savedRule = (await api(`/api/groups/${usd.id}/recurring`, users[0])).recurring.find((r: { id: number }) => r.id === rule.id);
  const editedRule = await api(`/api/recurring/${rule.id}`, users[0], { ...ruleBody, amountCents: 999, nextDate: String(savedRule.nextDate).slice(0, 10), active: true, expectedUpdatedAt: savedRule.updatedAt }, "PATCH");
  check("monthly title/amount edit keeps anchor", (await sql`SELECT anchor_day FROM recurring_expenses WHERE id = ${rule.id}`)[0].anchor_day, 31);
  check("stale recurring stop", (await request(`/api/recurring/${rule.id}?expectedUpdatedAt=${encodeURIComponent(savedRule.updatedAt)}`, users[0], undefined, "DELETE")).status, 400);
  await api(`/api/recurring/${rule.id}?expectedUpdatedAt=${encodeURIComponent(editedRule.updatedAt)}`, users[0], undefined, "DELETE");
  await groupData(usd);
  check("stopped rule keeps historical expenses", Number((await sql`SELECT count(*) FROM expenses WHERE recurring_id = ${rule.id}`)[0].count), expectedDates.length);
  const start = new Date(`${today}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 28);
  const weekly = await api(`/api/groups/${usd.id}/recurring`, users[0], { ...ruleBody, title: "Weekly catch-up", cadence: "weekly", startDate: start.toISOString().slice(0, 10) });
  await Promise.all([groupData(usd), groupData(usd)]);
  check("weekly catch-up concurrent idempotence", Number((await sql`SELECT count(*) FROM expenses WHERE recurring_id = ${weekly.id}`)[0].count), 5);
  for (const anchor of [29, 30, 31]) {
    const leapRule = await api(`/api/groups/${usd.id}/recurring`, users[0], { ...ruleBody, title: `Leap anchor ${anchor}`, startDate: `2024-01-${anchor}` });
    await groupData(usd); await groupData(usd);
    const expected = [];
    for (let month = 0; month < 36; month++) {
      const d = new Date(Date.UTC(2024, month, 1));
      d.setUTCDate(Math.min(anchor, new Date(Date.UTC(2024, month + 1, 0)).getUTCDate()));
      const day = d.toISOString().slice(0, 10); if (day <= today) expected.push(day);
    }
    check(`monthly leap anchor ${anchor} catch-up`, (await sql`SELECT expense_date::text AS day FROM expenses WHERE recurring_id = ${leapRule.id} ORDER BY expense_date`).map((r) => r.day), expected);
    const row = (await api(`/api/groups/${usd.id}/recurring`, users[0])).recurring.find((r: { id: number }) => r.id === leapRule.id);
    const shifted = await api(`/api/recurring/${leapRule.id}`, users[0], { ...ruleBody, title: "Shifted anchor", amountCents: 777,
      nextDate: "2099-01-15", active: true, expectedUpdatedAt: row.updatedAt }, "PATCH");
    check(`monthly anchor ${anchor} schedule edit`, Number((await sql`SELECT anchor_day FROM recurring_expenses WHERE id = ${leapRule.id}`)[0].anchor_day), 15);
    await api(`/api/recurring/${leapRule.id}?expectedUpdatedAt=${encodeURIComponent(shifted.updatedAt)}`, users[0], undefined, "DELETE");
  }
  const fractional = await request(`/api/groups/${yen.id}/recurring`, users[0], { ...ruleBody, amountCents: 155, currency: "JPY", startDate: "2099-01-31" });
  check("whole-yen recurring rejects fractional total", fractional.status, 400);
  await reconcile("mutated");
  const suggestions = (await groupData(usd)).suggestions;
  const first = suggestions[0];
  const fullBody = { payerId: first.from, recipientId: first.to, amountCents: first.amountCents, currency: "USD", date: today, note: "full", settleFullBalance: true };
  const actor = users.find((u) => u.id === first.from)!;
  const full = await Promise.all([request(`/api/groups/${usd.id}/settlements`, actor, fullBody), request(`/api/groups/${usd.id}/settlements`, actor, fullBody)]);
  check("concurrent group full balance", full.map((r) => r.status).sort(), [200, 400]);
  for (const t of (await groupData(usd)).suggestions) await api(`/api/groups/${usd.id}/settlements`, users.find((u) => u.id === t.from), { payerId: t.from, recipientId: t.to, amountCents: t.amountCents, currency: "USD", date: today });
  check("group plan applied through API clears balances", (await groupData(usd)).balances.map((b: { netCents: number }) => b.netCents), [0, 0, 0, 0]);
  await reconcile("settled");
  const size = await sql`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM groups) AS groups, (SELECT count(*) FROM expenses) AS expenses, (SELECT count(*) FROM expense_shares) AS shares, (SELECT count(*) FROM settlements) AS settlements, (SELECT count(*) FROM group_obligations) AS obligations, (SELECT count(*) FROM recurring_expenses) AS recurring`;
  console.log(JSON.stringify({ seed: 7301, today, dataset: size[0], passed, failed: failures.length, failures }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
