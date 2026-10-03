import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planMigration, splitStatements, writtenTables } from "../../../scripts/migration-guard";

const file = (name: string) => readFileSync(`scripts/${name}`, "utf8");

describe("migration row guard", () => {
  it("guards only the ledger for the notification migration, not trigger targets or function bodies", () => {
    const plan = planMigration(file("notifications.sql"));
    expect(plan.guarded).toEqual(["schema_migrations"]);
    expect(plan.statements.at(-1)).toMatch(/^INSERT INTO schema_migrations/);
  });

  it.each([
    ["migrations/20260929_group_balances.sql", ["schema_migrations"]],
    ["migrations/20260929_group_balances_create_requests.sql", ["group_obligations", "schema_migrations"]],
    ["migrations/20260929_group_balances_parent_check.sql", ["schema_migrations"]],
    ["migrations/20260929_group_balances_immutable_allocations.sql", ["schema_migrations"]],
  ])("plans %s", (name, guarded) => {
    const plan = planMigration(file(name));
    expect(plan.guarded).toEqual(guarded);
    expect(plan.statements.some((s) => /^(BEGIN|COMMIT)$/i.test(s))).toBe(false);
  });

  it("finds direct writes and ignores look-alikes", () => {
    const sql = `-- UPDATE users SET x = 1; is only a comment
      UPDATE public."users" u SET display_name = 'x';
      INSERT INTO settlements(id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1;
      CREATE TRIGGER t AFTER INSERT OR UPDATE ON nudges FOR EACH ROW EXECUTE FUNCTION f();
      CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN DELETE FROM groups; RETURN NULL; END $body$;
      DO $$ BEGIN DELETE FROM friendships WHERE false; END $$;`;
    expect(writtenTables(splitStatements(sql))).toEqual(["friendships", "settlements", "users"]);
  });

  it("refuses dynamic SQL until its tables are named, and honors expected changes", () => {
    const sql = "DO $$ BEGIN EXECUTE 'DELETE FROM sessions'; END $$";
    expect(() => planMigration(sql)).toThrow(/--writes/);
    expect(planMigration(sql, { writes: ["sessions"], expectChange: ["sessions"] })).toMatchObject({ guarded: [], unguarded: ["sessions"] });
  });
});
