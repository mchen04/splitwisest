import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { neon, neonConfig } from "@neondatabase/serverless";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const project = `splitwisest-local-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
const compose = ["compose", "--env-file", "/dev/null", "--project-name", project, "--file", "scripts/local-db.compose.yml"];

function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

function port(name: string, fallback: number) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${name} must be a port from 1 to 65535`);
  }
  return Number(value);
}

async function main() {
  if (process.argv[2] === "down") {
    run("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
    console.log("Local database removed.");
    return;
  }
  if (process.argv.length > 2) throw new Error("Use pnpm db:local or pnpm db:local:down");
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port("SPLITWISEST_PG_PORT", 5433)}/splitwisest`;
  const proxyUrl = `http://127.0.0.1:${port("SPLITWISEST_PROXY_PORT", 4444)}/sql`;
  run("docker", [...compose, "up", "--detach", "--wait", "--wait-timeout", "60"]);
  neonConfig.fetchEndpoint = () => proxyUrl;
  const sql = neon(databaseUrl);
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      await sql`SELECT 1`;
      break;
    } catch {
      if (Date.now() >= deadline) throw new Error("Local proxy did not become ready. Check Docker Desktop and rerun pnpm db:local.");
      await setTimeout(500);
    }
  }
  const env = { ...process.env, DATABASE_URL: databaseUrl, NEON_LOCAL_PROXY: proxyUrl };
  run(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], env);
  run(process.execPath, ["--import", "tsx", "scripts/migrate-notifications.ts"], env);
  console.log(`\nLocal database ready. Use these environment lines:\nDATABASE_URL=${databaseUrl}\nNEON_LOCAL_PROXY=${proxyUrl}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local database setup failed.");
  process.exitCode = 1;
});
