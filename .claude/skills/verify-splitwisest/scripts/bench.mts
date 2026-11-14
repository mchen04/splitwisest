import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { neon, neonConfig } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL ?? "";
const proxy = process.env.NEON_LOCAL_PROXY ?? "";
const baseUrl = process.env.SPLITWISEST_BASE_URL ?? "http://localhost:3391";
const dir = process.env.SPLITWISEST_BENCH_DIR ?? join(process.env.HOME ?? ".", ".cache/splitwisest/bench");
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (!databaseUrl || !loopback.has(new URL(databaseUrl).hostname) || !proxy || !loopback.has(new URL(proxy).hostname)) {
  throw new Error("bench needs loopback DATABASE_URL and NEON_LOCAL_PROXY");
}
if (!new URL(databaseUrl).pathname.includes("bench")) throw new Error("bench database name must contain 'bench'");
neonConfig.fetchEndpoint = () => proxy;
neonConfig.useSecureWebSocket = false;
neonConfig.poolQueryViaFetch = true;
const sql = neon(databaseUrl);

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "state.json");

interface State { seed: number; users: number[]; groups: number[]; bigGroup: number; token: string; unitGroups?: number[] }

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function equalSplit(total: number, n: number) {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => base + (i < total - base * n ? 1 : 0));
}

async function seed() {
  if (existsSync(statePath)) {
    console.log(JSON.stringify({ seeded: false, reason: "state exists", statePath }));
    return;
  }
  const seedValue = Number(flag("seed", "20261114"));
  const groupCount = Number(flag("groups", "6"));
  const memberCount = Number(flag("members", "6"));
  const expenseCount = Number(flag("expenses", "1500"));
  const settlementCount = Number(flag("settlements", "100"));
  const rand = lcg(seedValue);
  const userCount = memberCount + 2;
  const users: number[] = [];
  for (let i = 0; i < userCount; i++) {
    const rows = await sql`INSERT INTO users (username, display_name, password_hash, invite_code)
      VALUES (${`bench_${seedValue}_${i}`}, ${`Bench ${String.fromCharCode(65 + i)}`}, ${"scrypt:disabled:bench"}, ${`bench${seedValue}${i}`})
      RETURNING id`;
    users.push(Number(rows[0].id));
  }
  for (let a = 0; a < users.length; a++) for (let b = a + 1; b < users.length; b++) {
    await sql`INSERT INTO friendships (user_a, user_b) VALUES (${Math.min(users[a], users[b])}, ${Math.max(users[a], users[b])})`;
  }
  const groups: number[] = [];
  for (let g = 0; g < groupCount; g++) {
    const members = [users[0], ...Array.from({ length: memberCount - 1 }, (_, k) => users[1 + ((g + k) % (userCount - 1))])];
    const rows = await sql`INSERT INTO groups (name, currency, invite_code, created_by)
      VALUES (${`Bench group ${g + 1}`}, ${g % 3 === 2 ? "EUR" : "USD"}, ${`benchg${seedValue}${g}`}, ${users[0]}) RETURNING id`;
    const groupId = Number(rows[0].id);
    groups.push(groupId);
    for (const m of members) await sql`INSERT INTO group_members (group_id, user_id) VALUES (${groupId}, ${m})`;
    const count = g === 0 ? expenseCount * 2 : expenseCount;
    for (let start = 0; start < count; start += 250) {
      const batch = Math.min(250, count - start);
      const exp: { amount: number; payer: number; date: string; shares: number[]; n: number }[] = [];
      for (let i = 0; i < batch; i++) {
        const amount = 100 + Math.floor(rand() * 20000);
        const n = 2 + Math.floor(rand() * (memberCount - 1));
        const payer = members[Math.floor(rand() * members.length)];
        const day = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 300) * 86400_000).toISOString().slice(0, 10);
        exp.push({ amount, payer, date: day, shares: equalSplit(amount, n), n });
      }
      const idRows = await sql`SELECT nextval('expenses_id_seq')::bigint AS id FROM generate_series(1, ${batch})`;
      const ids = idRows.map((r) => Number(r.id));
      const shareExpense: number[] = [];
      const shareUser: number[] = [];
      const shareCents: number[] = [];
      exp.forEach((e, i) => e.shares.forEach((cents, k) => {
        shareExpense.push(ids[i]);
        shareUser.push(members[k]);
        shareCents.push(cents);
      }));
      const currency = g % 3 === 2 ? "EUR" : "USD";
      await sql.transaction([
        sql`INSERT INTO expenses (id, group_id, title, amount_cents, currency, converted_cents, fx_rate, expense_date, payer_id, split_method, created_by)
          SELECT t.id, ${groupId}, 'Bench expense ' || t.i, t.amount, ${currency}, t.amount, 1, t.d::date, t.payer, 'equal', ${users[0]}
          FROM unnest(${ids}::bigint[], ${exp.map((_, i) => start + i)}::int[], ${exp.map((e) => e.amount)}::bigint[], ${exp.map((e) => e.date)}::text[], ${exp.map((e) => e.payer)}::bigint[]) AS t(id, i, amount, d, payer)`,
        sql`INSERT INTO expense_shares (expense_id, user_id, share_cents)
          SELECT * FROM unnest(${shareExpense}::bigint[], ${shareUser}::bigint[], ${shareCents}::bigint[])`,
      ]);
    }
    for (let i = 0; i < settlementCount; i++) {
      const p = members[Math.floor(rand() * members.length)];
      let r = members[Math.floor(rand() * members.length)];
      if (r === p) r = members[(members.indexOf(p) + 1) % members.length];
      const amount = 100 + Math.floor(rand() * 5000);
      await sql`INSERT INTO settlements (group_id, payer_id, recipient_id, amount_cents, currency, converted_cents, settled_date, created_by)
        VALUES (${groupId}, ${p}, ${r}, ${amount}, ${g % 3 === 2 ? "EUR" : "USD"}, ${amount}, '2026-10-01', ${p})`;
    }
  }
  const token = randomBytes(32).toString("hex");
  await sql`INSERT INTO sessions (token, user_id, expires_at) VALUES (${token}, ${users[0]}, now() + interval '30 days')`;
  await sql`ANALYZE`;
  const state: State = { seed: seedValue, users, groups, bigGroup: groups[0], token };
  writeFileSync(statePath, JSON.stringify(state));
  chmodSync(statePath, 0o600);
  const counts = await sql`SELECT (SELECT count(*) FROM expenses WHERE group_id = ANY(${groups})) AS expenses,
    (SELECT count(*) FROM expense_shares es JOIN expenses e ON e.id = es.expense_id WHERE e.group_id = ANY(${groups})) AS shares,
    (SELECT count(*) FROM settlements WHERE group_id = ANY(${groups})) AS settlements`;
  console.log(JSON.stringify({ seeded: true, groups: groups.length, users: users.length, ...counts[0] }));
}

async function seedUnits() {
  const state = readState();
  if (state.unitGroups) {
    console.log(JSON.stringify({ seeded: false, reason: "units exist" }));
    return;
  }
  const rand = lcg(state.seed + 1);
  const perGroup = Number(flag("unit-expenses", "400"));
  const repayments = Number(flag("unit-settlements", "40"));
  for (const [g, groupId] of state.groups.entries()) {
    const memberRows = await sql`SELECT user_id FROM group_members WHERE group_id = ${groupId} ORDER BY user_id`;
    const members = memberRows.map((r) => Number(r.user_id));
    const units: number[] = [];
    for (const name of ["drinks", "chores", "points"]) {
      const rows = await sql`INSERT INTO group_units (group_id, name, created_by) VALUES (${groupId}, ${name}, ${state.users[0]}) RETURNING id`;
      units.push(Number(rows[0].id));
    }
    if (g % 2 === 1) await sql`UPDATE groups SET auto_reconcile_units = false WHERE id = ${groupId}`;
    const idRows = await sql`SELECT nextval('expenses_id_seq')::bigint AS id FROM generate_series(1, ${perGroup})`;
    const ids = idRows.map((r) => Number(r.id));
    const rows = ids.map((id, i) => {
      const amount = 100 * (1 + Math.floor(rand() * 6)) + (rand() < 0.3 ? 50 : 0);
      const n = 2 + Math.floor(rand() * (members.length - 1));
      return { id, i, amount, unit: units[Math.floor(rand() * units.length)], payer: members[Math.floor(rand() * members.length)], shares: equalSplit(amount, n) };
    });
    const se: number[] = [], su: number[] = [], sc: number[] = [];
    rows.forEach((r) => r.shares.forEach((c, k) => { se.push(r.id); su.push(members[k]); sc.push(c); }));
    await sql.transaction([
      sql`INSERT INTO expenses (id, group_id, title, amount_cents, currency, converted_cents, fx_rate, expense_date, payer_id, split_method, created_by, unit_id)
        SELECT t.id, ${groupId}, 'Bench unit ' || t.i, t.amount, g.currency, t.amount, 1, '2026-09-01', t.payer, 'equal', ${state.users[0]}, t.unit
        FROM unnest(${ids}::bigint[], ${rows.map((r) => r.i)}::int[], ${rows.map((r) => r.amount)}::bigint[], ${rows.map((r) => r.payer)}::bigint[], ${rows.map((r) => r.unit)}::bigint[]) AS t(id, i, amount, payer, unit)
        CROSS JOIN groups g WHERE g.id = ${groupId}`,
      sql`INSERT INTO expense_shares (expense_id, user_id, share_cents) SELECT * FROM unnest(${se}::bigint[], ${su}::bigint[], ${sc}::bigint[])`,
    ]);
    for (let i = 0; i < repayments; i++) {
      const p = members[Math.floor(rand() * members.length)];
      const r = members[(members.indexOf(p) + 1 + Math.floor(rand() * (members.length - 1))) % members.length];
      await sql`INSERT INTO settlements (group_id, payer_id, recipient_id, amount_cents, currency, converted_cents, settled_date, created_by, unit_id)
        SELECT ${groupId}, ${p}, ${r}, 50, g.currency, 50, '2026-10-02', ${p}, ${units[i % units.length]} FROM groups g WHERE g.id = ${groupId}`;
    }
  }
  await sql`ANALYZE`;
  state.unitGroups = state.groups;
  writeFileSync(statePath, JSON.stringify(state));
  const counts = await sql`SELECT count(*) FILTER (WHERE unit_id IS NOT NULL) AS unit_expenses, count(*) AS expenses FROM expenses WHERE group_id = ANY(${state.groups})`;
  console.log(JSON.stringify({ seeded: true, ...counts[0] }));
}

function readState(): State {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: s.length, median: q(0.5), p90: q(0.9), min: s[0], max: s[s.length - 1] };
}

function endpoints(state: State) {
  return [
    { name: "groups", path: "/api/groups", check: (j: any) => Array.isArray(j.groups ?? j) },
    { name: "friends", path: "/api/friends", check: (j: any) => j && typeof j === "object" },
    ...(state.unitGroups ? [{ name: "group-detail-off", path: `/api/groups/${state.groups[1]}`, check: (j: any) => Array.isArray(j.balances) }] : []),
    { name: "group-detail", path: `/api/groups/${state.bigGroup}`, check: (j: any) => Array.isArray(j.balances) && j.balances.reduce((a: number, b: any) => a + Number(b.netCents), 0) === 0 },
    { name: "group-expenses", path: `/api/groups/${state.bigGroup}/expenses?limit=50`, check: (j: any) => j && typeof j === "object" },
    { name: "expenses", path: "/api/expenses?limit=50", check: (j: any) => j && typeof j === "object" },
    { name: "sync", path: "/api/sync", check: (j: any) => j && typeof j === "object" },
  ];
}

async function timed(path: string, token: string) {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie: `sw_session=${token}` } });
  const text = await res.text();
  const ms = performance.now() - t0;
  let json: unknown = null;
  try { json = JSON.parse(text); } catch {}
  return { ms, status: res.status, json, bytes: text.length };
}

const relay = process.env.SPLITWISEST_BENCH_RELAY;
async function queries() {
  if (!relay) return NaN;
  const res = await fetch(`${relay}/__count`);
  return Number((await res.json()).count);
}

async function measure() {
  const state = readState();
  const label = flag("label", "run");
  const phase = flag("phase", "warm");
  const reps = Number(flag("reps", phase === "cold" ? "1" : "30"));
  const warmup = phase === "cold" ? 0 : Number(flag("warmup", "5"));
  const out: Record<string, unknown> = { label, phase, reps, at: new Date().toISOString() };
  let errors = 0;
  for (const ep of endpoints(state)) {
    for (let i = 0; i < warmup; i++) await timed(ep.path, state.token);
    const ms: number[] = [];
    let bytes = 0;
    const before = await queries();
    for (let i = 0; i < reps; i++) {
      const r = await timed(ep.path, state.token);
      if (r.status !== 200 || !ep.check(r.json)) errors++;
      ms.push(r.ms);
      bytes = r.bytes;
    }
    out[ep.name] = { ...stats(ms), bytes, queriesPerRequest: ((await queries()) - before) / reps };
  }
  out.errors = errors;
  const line = JSON.stringify(out);
  appendFileSync(join(dir, "results.jsonl"), line + "\n");
  console.log(line);
}

async function sqlBench() {
  const state = readState();
  const label = flag("label", "run");
  const reps = Number(flag("reps", "30"));
  const out: Record<string, unknown> = { label, phase: "sql", reps, at: new Date().toISOString() };
  const ms: number[] = [];
  for (let i = 0; i < reps + 3; i++) {
    const plan = await sql.query(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM group_balance_rows($1)`, [state.bigGroup]);
    const exec = Number((plan[0] as any)["QUERY PLAN"][0]["Execution Time"]);
    if (i >= 3) ms.push(exec);
  }
  const rows = await sql`SELECT COALESCE(SUM(net_cents), 0)::bigint AS total, count(*) AS n FROM group_balance_rows(${state.bigGroup})`;
  out.groupBalanceRows = stats(ms);
  out.netSum = Number(rows[0].total);
  out.members = Number(rows[0].n);
  out.errors = Number(rows[0].total) === 0 ? 0 : 1;
  const line = JSON.stringify(out);
  appendFileSync(join(dir, "results.jsonl"), line + "\n");
  console.log(line);
}

const commands: Record<string, () => Promise<void>> = { seed, "seed-units": seedUnits, measure, sql: sqlBench };
if (!commands[command]) {
  console.error("usage: bench.ts seed|measure|sql [--label L] [--phase warm|cold] [--reps N]");
  process.exit(2);
}
await commands[command]();
