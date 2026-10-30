import { readFileSync } from "node:fs";
import { neon, neonConfig } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { planMigration } from "../../../scripts/migration-guard";

const migrations = ["20261030_expense_share_cover_index", "20261030_expense_date_index", "20261030_message_participant_index"];
const scripts = migrations.map((name) => readFileSync(`scripts/migrations/${name}.sql`, "utf8"));
const databaseUrl = process.env.SCHEMA_TEST_DATABASE_URL;
const proxyUrl = process.env.SCHEMA_TEST_PROXY_URL;

function localSql() {
  if (!databaseUrl || !proxyUrl) throw new Error("Set both local schema test URLs");
  for (const url of [databaseUrl, proxyUrl]) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
      throw new Error("Schema tests require loopback URLs");
    }
  }
  neonConfig.fetchEndpoint = () => proxyUrl;
  return neon(databaseUrl);
}

type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

describe("hot query index migrations", () => {
  it.each(scripts)("changes only indexes and the migration ledger", (script) => {
    const plan = planMigration(script);
    expect(plan.guarded).toEqual(["schema_migrations"]);
    expect(plan.unguarded).toEqual([]);
    expect(plan.statements.every((statement) =>
      /^CREATE INDEX IF NOT EXISTS /i.test(statement) || /^INSERT INTO schema_migrations /i.test(statement)
    )).toBe(true);
  });

  describe.skipIf(!databaseUrl || !proxyUrl)("local seeded database", () => {
    it("keeps expense and balance rows unchanged after two applications", async () => {
      const sql = localSql();
      const snapshot = async () => sql`
        SELECT 'expenses' AS name, count(*)::text AS count,
          md5(string_agg(md5(to_jsonb(e)::text), '' ORDER BY id)) AS hash FROM expenses e
        UNION ALL
        SELECT 'shares', count(*)::text,
          md5(string_agg(md5(to_jsonb(s)::text), '' ORDER BY expense_id, user_id)) FROM expense_shares s
        UNION ALL
        SELECT 'balances', count(*)::text,
          md5(string_agg(to_jsonb(b)::text, '' ORDER BY user_id)) FROM group_balance_rows(21) b
        ORDER BY name`;
      const before = await snapshot();
      expect(Number(before.find((row) => row.name === "expenses")?.count)).toBeGreaterThanOrEqual(10000);
      for (let run = 0; run < 2; run++) {
        for (const script of scripts) {
          await sql.transaction(planMigration(script).statements.map((statement) => sql.query(statement)));
        }
      }
      expect(await snapshot()).toEqual(before);
    }, 30000);

    it("reads balance shares through the covering index", async () => {
      const sql = localSql();
      const rows = await sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM group_balance_rows(21)`;
      const nodes = planNodes(rows[0]["QUERY PLAN"][0].Plan);
      expect(nodes.some((node) => node["Node Type"] === "Index Only Scan" && node["Index Name"] === "expense_shares_cover_idx")).toBe(true);
    });

    it("indexes messages addressed to either participant", async () => {
      const sql = localSql();
      const rows = await sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT CASE WHEN dm_a = 1 THEN dm_b ELSE dm_a END AS friend_id, max(id)
        FROM messages WHERE channel = 'dm' AND sender_id <> 1 AND (dm_a = 1 OR dm_b = 1)
        GROUP BY 1`;
      expect(planNodes(rows[0]["QUERY PLAN"][0].Plan).some((node) => node["Index Name"] === "messages_dm_b_idx")).toBe(true);
    });

    it("reads a cross-group expense page in date order through the index", async () => {
      const sql = localSql();
      const rows = await sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT e.id, e.group_id, g.name, e.title, e.amount_cents, e.currency,
          e.converted_cents, e.expense_date, p.display_name, c.name AS category_name
        FROM expenses e
        JOIN groups g ON g.id = e.group_id
        JOIN users p ON p.id = e.payer_id
        LEFT JOIN categories c ON c.id = e.category_id
        WHERE e.group_id IN (SELECT group_id FROM group_members WHERE user_id = 1)
        ORDER BY e.expense_date DESC, e.id DESC LIMIT 51`;
      expect(planNodes(rows[0]["QUERY PLAN"][0].Plan).some((node) => node["Index Name"] === "expenses_date_idx")).toBe(true);
    });
  });
});
