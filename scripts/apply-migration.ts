import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { planMigration, type MigrationPlan } from "./migration-guard";

type Sql = NeonQueryFunction<false, false>;

// Saves the rows of every table the migration writes, then applies it in one guarded transaction.
export async function applyGuardedMigration(sql: Sql, name: string, plan: MigrationPlan) {
  const tables = [...plan.guarded, ...plan.unguarded];
  const existing = new Set((await sql`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ANY(${tables}::text[])`).map((r) => r.table_name as string));
  const snapshot: Record<string, unknown[]> = {};
  for (const table of tables.filter((t) => existing.has(t))) {
    snapshot[table] = (await sql.query(`SELECT row_to_json(x) AS row FROM "${table}" x`)).map((r) => r.row);
  }
  mkdirSync(".migration-snapshots", { recursive: true, mode: 0o700 });
  const file = `.migration-snapshots/${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ name, takenAt: new Date().toISOString(), tables: snapshot }), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`Snapshot saved to ${file}: ${Object.entries(snapshot).map(([t, rows]) => `${t} ${rows.length}`).join(", ") || "no existing rows"}.`);
  await sql.transaction((tx) => plan.transaction.map((statement) => tx.query(statement)));
  console.log(`Applied ${plan.statements.length} statements. Existing rows unchanged in: ${plan.guarded.join(", ") || "none written"}.`);
  if (plan.unguarded.length) console.log(`Changes allowed in: ${plan.unguarded.join(", ")}. Compare them with the snapshot.`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { writes: { type: "string", multiple: true }, "expect-change": { type: "string", multiple: true }, "print-transaction": { type: "boolean" } },
  });
  if (positionals.length !== 1) throw new Error("Usage: pnpm migrate:apply <file.sql> [--writes table] [--expect-change table] [--print-transaction]");
  const plan = planMigration(readFileSync(positionals[0], "utf8"), { writes: values.writes, expectChange: values["expect-change"] });
  if (values["print-transaction"]) {
    console.log(plan.transaction.map((s) => `${s};`).join("\n"));
    return;
  }
  if (existsSync(".env.local")) loadEnvFile(".env.local");
  await import("../src/lib/neon-local");
  await applyGuardedMigration(neon(process.env.DATABASE_URL!), basename(positionals[0], ".sql"), plan);
}

if (process.argv[1]?.endsWith("apply-migration.ts")) {
  main().catch((e) => { console.error(`Migration not applied; transaction rolled back. ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
}
