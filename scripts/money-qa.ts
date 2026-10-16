import "../src/lib/neon-local";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";

function loopback(value: string, protocols: string[], label: string) {
  const url = new URL(value);
  assert(protocols.includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), `${label} must use a loopback host`);
  assert(!url.search && !url.hash, `${label} must not contain query parameters or a fragment`);
  return url;
}

export function moneyQaTarget(browser = false) {
  const base = loopback((browser ? process.env.SPLITWISEST_BROWSER_URL : undefined)
    ?? process.env.SPLITWISEST_BASE_URL ?? "http://127.0.0.1:3000", ["http:", "https:"], "App URL");
  assert(base.pathname === "/" && !base.username && !base.password, "App URL must contain only an origin");
  const database = loopback(process.env.DATABASE_URL ?? "http://invalid", ["postgres:", "postgresql:"], "DATABASE_URL");
  assert.equal(database.pathname, "/splitwisest_money_qa", "Use the dedicated splitwisest_money_qa database");
  assert(process.env.NEON_LOCAL_PROXY, "NEON_LOCAL_PROXY is required");
  const proxy = loopback(process.env.NEON_LOCAL_PROXY, ["http:", "https:"], "NEON_LOCAL_PROXY");
  assert(!proxy.username && !proxy.password, "Proxy URL must not contain credentials");
  const password = process.env.SPLITWISEST_MONEY_QA_PASSWORD ?? randomBytes(32).toString("hex");
  return { base, sql: neon(database.href), password };
}

export async function confirmMoneyQaApp(sql: NeonQueryFunction<false, false>, readMe: (cookie: string) => Promise<{ user?: { id: number } }>) {
  assert.equal((await sql`SELECT current_database() AS name`)[0].name, "splitwisest_money_qa");
  const token = randomBytes(32).toString("hex");
  const username = `money_qa_probe_${randomBytes(8).toString("hex")}`;
  const rows = await sql`WITH fixture AS (
    INSERT INTO users(username, display_name, password_hash, invite_code)
    VALUES (${username}, 'Synthetic QA database probe', 'synthetic-no-login', ${token}) RETURNING id
  ) INSERT INTO sessions(token, user_id, expires_at)
    SELECT ${token}, id, now() + interval '1 minute' FROM fixture RETURNING user_id`;
  const id = Number(rows[0].user_id);
  try {
    assert.equal((await readMe(`sw_session=${token}`)).user?.id, id, "App must connect to splitwisest_money_qa");
  } finally {
    await sql`DELETE FROM users WHERE id = ${id}`;
  }
}
