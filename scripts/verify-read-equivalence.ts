import { randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const base = process.env.SPLITWISEST_BASE_URL ?? "http://127.0.0.1:3741";
const target = new URL(base);
assert.equal(target.hostname, "127.0.0.1");
assert(/^374[0-9]$/.test(target.port));
const [mode, name] = process.argv.slice(2);
assert(mode === "--write" || mode === "--compare");
assert(name && !resolve(name).startsWith(`${process.cwd()}/`), "Keep snapshots outside the checkout");

async function main() {
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "maya_chen_bench", password: process.env.SPLITWISEST_MONEY_QA_PASSWORD ?? randomBytes(32).toString("hex") }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const read = async (path: string, session = cookie) => {
    const response = await fetch(`${base}${path}`, { headers: { cookie: session } });
    return { status: response.status, body: await response.json() };
  };
  const results: Record<string, unknown> = {};
  const groups = await read("/api/groups");
  assert.equal(groups.status, 200);
  const paths = ["/api/groups", "/api/friends", ...groups.body.groups.flatMap((g: { id: number }) => [
    `/api/groups/${g.id}`, `/api/groups/${g.id}/version`, `/api/groups/${g.id}/expenses?limit=50`, `/api/groups/${g.id}/group-balances`,
  ])];
  for (const path of paths) {
    const row = await read(path);
    assert.equal(row.status, 200, path);
    results[path] = row.body;
  }
  const first = groups.body.groups[0].id;
  for (const path of [`/api/groups/${first}`, `/api/groups/${first}/version`, `/api/groups/${first}/group-balances`, "/api/friends", "/api/groups/999999999", "/api/groups/nope"]) {
    assert.equal((await read(path, "sw_session=synthetic-invalid-session")).status, 401, `${path} session guard`);
  }
  assert.equal((await read("/api/groups/999999999")).status, 404);
  assert.equal((await read("/api/groups/nope")).status, 404);
  if (mode === "--write") writeFileSync(name, JSON.stringify(results, null, 2));
  else assert.deepEqual(results, JSON.parse(readFileSync(name, "utf8")));
  console.log(`${mode === "--write" ? "Captured" : "Matched"} ${paths.length} read responses; 8 authorization checks pass`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
