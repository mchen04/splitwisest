#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { neon, neonConfig } from "@neondatabase/serverless";

const root = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
const work = resolve(process.env.SPLITWISEST_VERIFY_DIR ?? `${homedir()}/.cache/splitwisest/verify-${hash}`);
const evidence = resolve(work, "evidence");
const statePath = resolve(work, "instance.json");
const docker = existsSync("/Applications/Docker.app/Contents/Resources/bin/docker")
  ? "/Applications/Docker.app/Contents/Resources/bin/docker" : "docker";
const container = `splitwisest-local-${hash}-postgres-1`;
const database = "splitwisest_money_qa";

function run(command, args, env = process.env, transcript) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: transcript ? "pipe" : "inherit" });
  if (transcript) {
    writeFileSync(transcript, `${result.stdout ?? ""}${result.stderr ?? ""}\nExit: ${result.status}\n`);
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}

function psql(query, capture = false) {
  const result = spawnSync(docker, ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tAc", query], {
    encoding: "utf8", stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "Local database command failed");
  return result.stdout?.trim();
}

function readState() {
  assert(existsSync(statePath), "Run launch first");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.root, root, "Instance belongs to another checkout");
  return state;
}

function environment(state) {
  return {
    ...process.env,
    PATH: `${resolve(docker, "..")}:${process.env.PATH}`,
    DATABASE_URL: state.databaseUrl,
    NEON_LOCAL_PROXY: state.proxyUrl,
    SPLITWISEST_BROWSER_URL: state.base,
    SPLITWISEST_BASE_URL: state.base,
    SPLITWISEST_EVIDENCE_DIR: evidence,
    GITHUB_SHA: state.version,
    VERCEL: "0",
    ALLOW_REMOTE_DB: "0",
  };
}

async function launch() {
  assert(!existsSync(statePath), "Instance state exists; run doctor or cleanup first");
  const port = Number(process.env.SPLITWISEST_VERIFY_PORT ?? 3391);
  const pgPort = Number(process.env.SPLITWISEST_PG_PORT ?? 55433);
  const proxyPort = Number(process.env.SPLITWISEST_PROXY_PORT ?? 54444);
  for (const value of [port, pgPort, proxyPort]) assert(Number.isInteger(value) && value > 0 && value < 65536, "Invalid port");
  await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, () => server.close(accept));
  });
  assert(!existsSync(resolve(root, ".next/dev/lock")), "Another dev server may own this checkout");
  mkdirSync(evidence, { recursive: true });
  const state = {
    root, version: `verify-${randomBytes(8).toString("hex")}`, base: `http://localhost:${port}`,
    databaseUrl: `postgres://postgres:postgres@127.0.0.1:${pgPort}/${database}`,
    proxyUrl: `http://127.0.0.1:${proxyPort}/sql`, databaseCreated: false, pid: null,
  };
  writeFileSync(statePath, JSON.stringify(state));
  const env = { ...environment(state), SPLITWISEST_PG_PORT: String(pgPort), SPLITWISEST_PROXY_PORT: String(proxyPort) };
  run("pnpm", ["db:local"], env);
  if (!psql(`SELECT 1 FROM pg_database WHERE datname = '${database}'`, true)) {
    psql(`CREATE DATABASE ${database}`);
    state.databaseCreated = true;
    writeFileSync(statePath, JSON.stringify(state));
  }
  run("pnpm", ["exec", "tsx", "scripts/migrate.ts"], env);
  run("pnpm", ["exec", "tsx", "scripts/migrate-notifications.ts"], env);
  const log = openSync(resolve(evidence, "server.log"), "a");
  const child = spawn(process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "dev", "--port", String(port)], {
    cwd: root, env, stdio: ["ignore", log, log], detached: true,
  });
  state.pid = child.pid;
  state.startedAt = spawnSync("ps", ["-p", String(state.pid), "-o", "lstart="], { encoding: "utf8" }).stdout.trim();
  assert(state.startedAt, "Cannot record server process ownership");
  writeFileSync(statePath, JSON.stringify(state));
  closeSync(log);
  child.unref();
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${state.base}/api/version`);
      if (response.ok && (await response.json()).version === state.version) {
        await doctor();
        return;
      }
    } catch {}
    await setTimeout(500);
  }
  throw new Error(`Server is not ready; inspect ${resolve(evidence, "server.log")}`);
}

async function doctor() {
  const state = readState();
  assert(state.pid, "Server has not started");
  process.kill(state.pid, 0);
  const response = await fetch(`${state.base}/api/version`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, state.version, "Wrong app instance");
  neonConfig.fetchEndpoint = () => state.proxyUrl;
  const sql = neon(state.databaseUrl);
  const rows = await sql`SELECT current_database() AS name, to_regclass('users') AS users,
    to_regclass('expense_shares') AS shares, to_regprocedure('group_balance_rows(bigint)') AS balances,
    to_regclass('notifications') AS notifications`;
  assert.equal(rows[0].name, database);
  for (const key of ["users", "shares", "balances", "notifications"]) assert(rows[0][key], `Missing ${key}; migration is incomplete`);
  console.log(`PASS doctor: owned app at ${state.base}, migrated local database`);
}

async function drive() {
  await doctor();
  const state = readState();
  const browserPath = process.env.SPLITWISEST_CHROMIUM_PATH
    ?? `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
  assert(existsSync(browserPath), "Set SPLITWISEST_CHROMIUM_PATH to an installed Chromium executable");
  const feature = process.argv[3] ?? "shares";
  assert(["shares", "all"].includes(feature), "Use drive shares or drive all");
  run("pnpm", ["exec", "tsx", "scripts/verify-money-form.ts"], {
    ...environment(state), SPLITWISEST_CHROMIUM_PATH: browserPath, SPLITWISEST_MONEY_FORM_FEATURE: feature,
  }, resolve(evidence, `drive-${feature}.log`));
  console.log(`PASS drive ${feature}: ${evidence}`);
}

async function cleanup() {
  const state = readState();
  if (state.pid) {
    let alive = true;
    try { process.kill(state.pid, 0); } catch { alive = false; }
    if (alive) {
      const startedAt = spawnSync("ps", ["-p", String(state.pid), "-o", "lstart="], { encoding: "utf8" }).stdout.trim();
      assert(state.startedAt && state.startedAt === startedAt, "Cannot confirm server process ownership; leave PID untouched");
      process.kill(-state.pid, "SIGTERM");
      for (let i = 0; i < 100; i++) {
        try { process.kill(state.pid, 0); } catch { alive = false; break; }
        await setTimeout(100);
      }
      assert(!alive, "Server did not stop; leave state for inspection");
    }
  }
  if (state.databaseCreated) psql(`DROP DATABASE ${database} WITH (FORCE)`);
  unlinkSync(statePath);
  const expected = ["after-form.png", "after-saved.png", "after-balances.png", "after-edit-reload.png", "money-form-proof.json"];
  const retained = expected.filter((file) => existsSync(resolve(evidence, file)));
  console.log(`PASS cleanup: owned server removed; ${retained.length}/${expected.length} proof artifacts retained at ${evidence}`);
}

const command = process.argv[2];
try {
  assert(["launch", "doctor", "drive", "cleanup"].includes(command), "Use launch, doctor, drive [shares|all], or cleanup");
  await ({ launch, doctor, drive, cleanup })[command]();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
