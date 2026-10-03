import { neon } from "@neondatabase/serverless";
import { existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { applyGuardedMigration } from "./apply-migration";
import { planMigration } from "./migration-guard";

if (existsSync(".env.local")) loadEnvFile(".env.local");
const plan = planMigration(readFileSync(new URL("./notifications.sql", import.meta.url), "utf8"));

async function main() {
  await import("../src/lib/neon-local");
  const sql = neon(process.env.DATABASE_URL!);
  await applyGuardedMigration(sql, "notifications", plan);
  const [tables, triggers] = await sql.transaction((tx) => [
    tx`SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name IN
        ('notification_preferences','push_subscriptions','notifications','notification_deliveries')`,
    tx`SELECT count(*)::int AS count FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema()
      AND t.tgname IN ('notifications_queue_push','activity_notifications','message_notifications',
        'comment_notifications','nudge_notifications','friend_request_notifications','group_deleted_notifications')`,
  ]);
  if (tables[0].count !== 4 || triggers[0].count !== 7) throw new Error("Notification schema readback failed");
  console.log("Notification schema verified: four tables and seven triggers. No activity backfill.");
}
main().catch(() => { console.error("Notification migration failed; transaction rolled back. Check database configuration."); process.exitCode = 1; });
